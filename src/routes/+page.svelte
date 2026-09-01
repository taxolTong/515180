<script lang="ts">
	import { onMount } from 'svelte';
	import { Chart } from 'chart.js/auto';
	import {
		ChartLine,
		RefreshCw,
		Ruler,
		Target,
		ClipboardList,
		Keyboard,
		TriangleAlert,
		MapPin,
		CircleCheck,
		Flame,
		ChevronsUp,
		ChevronUp,
		ChevronsDown,
		ChevronDown,
		Minus
	} from '@lucide/svelte';
	import {
		addDays,
		calcBands,
		daysFromBase,
		getZone,
		isValidPrice,
		round,
		trendValue,
		type BandsOfToday,
		type Zone
	} from '$lib/model';
	import type { HistoryPoint, HistoryResponse, Model, Quote } from '$lib/types';

	let history = $state<HistoryPoint[]>([]);
	let model = $state<Model | null>(null);
	let quote = $state<Quote | null>(null);
	let manual = $state<Quote | null>(null);
	let status = $state<'loading' | 'ok' | 'error' | 'manual'>('loading');
	let statusText = $state('正在获取实时行情…');
	let manualPrice = $state('');
	let chartCanvas = $state<HTMLCanvasElement | null>(null);
	let chart: Chart | null = null;

	const today = new Date().toISOString().slice(0, 10);

	const effective = $derived(manual ?? quote);
	const bands: BandsOfToday | null = $derived(model && effective ? calcBands(model, today) : null);
	const zone: Zone | null = $derived(bands && effective ? getZone(effective.price, bands) : null);
	const deviationPct = $derived(bands ? ((effective!.price - bands.trend) / bands.trend) * 100 : 0);

	const priceClass = $derived(
		zone ? (zone.includes('low') ? 'buy' : zone.includes('high') ? 'sell' : 'neutral') : 'neutral'
	);

	const STATUS_COLOR: Record<string, string> = {
		loading: '#f59e0b',
		ok: '#22c55e',
		error: '#ef4444',
		manual: '#38bdf8'
	};

	const ZONE_META: Record<
		Zone,
		{
			label: string;
			tagClass: string;
			color: string;
			title: string;
			body: string;
			icon: typeof Flame;
		}
	> = {
		extreme_low: {
			label: '极端低估区',
			tagClass: 'tag-buy',
			color: '#22c55e',
			title: '极端低估',
			body: '当前价格远低于历史1%分位，是极限抄底机会，可大幅加仓。日内跌0.40%即加仓，收盘前保持仓位。',
			icon: Flame
		},
		low: {
			label: '低估区',
			tagClass: 'tag-buy',
			color: '#4ade80',
			title: '低估区',
			body: '价格低于95%历史交易日，任何回调都是加仓机会。日内相对开盘跌≥0.40%即加仓，不T出。',
			icon: CircleCheck
		},
		normal: {
			label: '正常区间',
			tagClass: 'tag-neutral',
			color: '#38bdf8',
			title: '正常区间',
			body: '价格在趋势通道内波动。做T模式：跌0.50%买入，涨0.50%卖出。铁律：收盘前必须平回仓位！',
			icon: MapPin
		},
		high: {
			label: '高估区',
			tagClass: 'tag-sell',
			color: '#fb923c',
			title: '高估区',
			body: '价格高于95%历史交易日，日内冲高即减仓，涨≥0.40%（相对开盘）执行减仓，不追回。',
			icon: TriangleAlert
		},
		extreme_high: {
			label: '极端高估区',
			tagClass: 'tag-sell',
			color: '#f87171',
			title: '极端高估',
			body: '当前价格远高于历史99%分位，是大幅减仓信号。日内涨0.40%即减仓，不追回。',
			icon: TriangleAlert
		}
	};

	const LEVELS = [
		{
			id: 'exHigh' as const,
			label: '极端高估线 (99%)',
			icon: ChevronsUp,
			color: '#f87171',
			cls: 'exhigh'
		},
		{
			id: 'high' as const,
			label: '高估减仓线 (95%)',
			icon: ChevronUp,
			color: '#fb923c',
			cls: 'high'
		},
		{ id: 'trend' as const, label: '中心趋势线', icon: Minus, color: '#38bdf8', cls: 'trend' },
		{
			id: 'low' as const,
			label: '低估加仓线 (5%)',
			icon: ChevronDown,
			color: '#4ade80',
			cls: 'low'
		},
		{
			id: 'exLow' as const,
			label: '极端低估线 (1%)',
			icon: ChevronsDown,
			color: '#22c55e',
			cls: 'exlow'
		}
	];

	const levelValues = $derived(
		bands
			? {
					exHigh: bands.high99,
					high: bands.high95,
					trend: bands.trend,
					low: bands.low05,
					exLow: bands.low01
				}
			: null
	);

	const subtitle = $derived(
		model
			? `基于 ${model.baseDate}–${history[history.length - 1].date} 共 ${history.length} 周数据建模 | 基准日: ${model.baseDate}`
			: ''
	);

	const barPct = $derived(Math.max(0, Math.min(100, 50 + (deviationPct / 0.3) * 50)));

	async function loadHistory() {
		try {
			const res = await fetch('/api/history');
			if (!res.ok) throw new Error();
			const data: HistoryResponse = await res.json();
			model = data;
			history = data.history;
		} catch {
			statusText = '历史数据加载失败';
		}
	}

	async function loadQuote() {
		status = 'loading';
		statusText = '正在获取实时行情…';
		try {
			const res = await fetch('/api/quote');
			if (!res.ok) throw new Error();
			const q: Quote = await res.json();
			quote = q;
			manual = null;
			status = 'ok';
			statusText = `已连接 ${q.source} | ${q.name} | ${q.time}`;
		} catch {
			status = 'error';
			statusText = '实时行情获取失败，请使用下方手动输入';
		}
	}

	function applyManualPrice() {
		const v = parseFloat(manualPrice);
		if (!v || v <= 0) {
			alert('请输入有效价格');
			return;
		}
		if (!isValidPrice(v)) {
			alert('价格超出合理范围(1.0~2.0)，请确认输入的是515180的价格');
			return;
		}
		manual = {
			price: v,
			open: v,
			high: v,
			low: v,
			name: '手动输入',
			source: '手动',
			time: new Date().toLocaleTimeString()
		};
		status = 'manual';
		statusText = `手动输入价格: ${v.toFixed(3)}`;
	}

	$effect(() => {
		if (!model || history.length === 0 || !chartCanvas) return;
		buildChart();
	});

	function buildChart() {
		if (!model || !chartCanvas) return;
		chart?.destroy();
		const ctx = chartCanvas.getContext('2d');
		if (!ctx) return;

		const labels = history.map((d) => d.date);
		const prices: (number | null)[] = history.map((d) => d.price);
		const trends = history.map((d) => d.trend);
		const high95 = history.map((d) => d.high95);
		const low05 = history.map((d) => d.low05);
		const high99 = history.map((d) => d.high99);
		const low01 = history.map((d) => d.low01);

		const lastDays = daysFromBase(history[history.length - 1].date, model.baseDate);
		for (let i = 1; i <= 30; i++) {
			labels.push(addDays(history[history.length - 1].date, i));
			const t = round(trendValue(model, lastDays + i));
			trends.push(t);
			high95.push(round(t + model.bands.high95));
			low05.push(round(t + model.bands.low05));
			high99.push(round(t + model.bands.high99));
			low01.push(round(t + model.bands.low01));
			prices.push(null);
		}

		chart = new Chart(ctx, {
			type: 'line',
			data: {
				labels,
				datasets: [
					{
						label: '收盘价',
						data: prices,
						borderColor: '#38bdf8',
						backgroundColor: 'rgba(56,189,248,0.1)',
						borderWidth: 1.5,
						pointRadius: 0,
						tension: 0.1,
						fill: false
					},
					{
						label: '中心趋势',
						data: trends,
						borderColor: '#f472b6',
						borderWidth: 2,
						pointRadius: 0,
						tension: 0.1
					},
					{
						label: '高估线(95%)',
						data: high95,
						borderColor: '#fb923c',
						borderWidth: 1.5,
						borderDash: [6, 4],
						pointRadius: 0,
						tension: 0.1
					},
					{
						label: '低估线(5%)',
						data: low05,
						borderColor: '#4ade80',
						borderWidth: 1.5,
						borderDash: [6, 4],
						pointRadius: 0,
						tension: 0.1
					},
					{
						label: '极端高(99%)',
						data: high99,
						borderColor: '#f87171',
						borderWidth: 1,
						borderDash: [3, 3],
						pointRadius: 0,
						tension: 0.1
					},
					{
						label: '极端低(1%)',
						data: low01,
						borderColor: '#22c55e',
						borderWidth: 1,
						borderDash: [3, 3],
						pointRadius: 0,
						tension: 0.1
					}
				]
			},
			options: {
				responsive: true,
				maintainAspectRatio: false,
				interaction: { mode: 'index', intersect: false },
				plugins: {
					legend: {
						labels: { color: '#94a3b8', font: { size: 11 } },
						position: 'top'
					},
					tooltip: {
						backgroundColor: 'rgba(15,23,42,0.95)',
						titleColor: '#e2e8f0',
						bodyColor: '#e2e8f0',
						borderColor: '#334155',
						borderWidth: 1
					}
				},
				scales: {
					x: {
						grid: { color: 'rgba(51,65,85,0.3)' },
						ticks: { color: '#94a3b8', maxTicksLimit: 10 }
					},
					y: {
						grid: { color: 'rgba(51,65,85,0.3)' },
						ticks: { color: '#94a3b8' }
					}
				}
			}
		});
	}

	onMount(() => {
		loadHistory();
		loadQuote();
		const timer = setInterval(loadQuote, 30000);
		return () => clearInterval(timer);
	});
</script>

<svelte:head>
	<title>515180 中证红利ETF — 趋势通道交易系统</title>
	<meta
		name="description"
		content="515180 中证红利ETF 趋势通道交易系统，基于历史数据拟合线性趋势通道，提供实时买卖建议。"
	/>
</svelte:head>

<div class="container">
	<h1><ChartLine size={22} class="title-icon" /> 515180 中证红利ETF — 趋势通道交易系统</h1>
	<div class="subtitle">{subtitle || '正在加载历史数据…'}</div>

	<div class="status-bar">
		<div class="status-indicator" style="background:{STATUS_COLOR[status]};"></div>
		<span style="font-size:0.85rem;color:var(--muted);">{statusText}</span>
		<button class="btn btn-secondary btn-sm" onclick={loadQuote}>
			<RefreshCw size={14} /> 刷新
		</button>
	</div>

	<div class="grid grid-3">
		<div class="card">
			<div class="card-title">当前价格</div>
			<div class="big-number {priceClass}">{effective ? effective.price.toFixed(3) : '--'}</div>
			<div style="display:flex;gap:12px;margin-top:4px;font-size:0.8rem;color:var(--muted);">
				<span>开盘: <b>{effective?.open.toFixed(3) ?? '--'}</b></span>
				<span>最高: <b>{effective?.high.toFixed(3) ?? '--'}</b></span>
				<span>最低: <b>{effective?.low.toFixed(3) ?? '--'}</b></span>
			</div>
			<div class="tag {zone ? ZONE_META[zone].tagClass : 'tag-neutral'}">
				{zone ? ZONE_META[zone].label : '等待数据'}
			</div>
			<div class="debug-info">{effective?.source ? '来源: ' + effective.source : ''}</div>
		</div>

		<div class="card">
			<div class="card-title">趋势偏离度</div>
			<div class="big-number {deviationPct > 0 ? 'sell' : deviationPct < 0 ? 'buy' : 'neutral'}">
				{bands ? (deviationPct >= 0 ? '+' : '') + deviationPct.toFixed(2) + '%' : '--'}
			</div>
			<div class="progress-bar">
				<div
					class="progress-fill"
					style="width:{barPct}%;background:{zone ? ZONE_META[zone].color : 'var(--accent)'};"
				></div>
			</div>
			<div
				style="display:flex;justify-content:space-between;font-size:0.7rem;color:var(--muted);margin-top:4px;"
			>
				<span>低估</span><span>趋势</span><span>高估</span>
			</div>
		</div>

		<div class="card">
			<div class="card-title">今日操作建议</div>
			{#if zone}
				{@const ZoneIcon = ZONE_META[zone].icon}
				<div
					class="advice-box {zone.includes('low')
						? 'buy-zone'
						: zone.includes('high')
							? 'sell-zone'
							: ''}"
				>
					<div class="advice-title" style="color:{ZONE_META[zone].color};">
						<ZoneIcon size={16} />
						{ZONE_META[zone].title}
					</div>
					<p>{ZONE_META[zone].body}</p>
				</div>
			{:else}
				<p style="font-size:0.9rem;">正在计算…</p>
			{/if}
		</div>
	</div>

	<div class="grid grid-2" style="margin-top:16px;">
		<div class="card">
			<div class="card-title"><Ruler size={15} /> 今日趋势通道价格</div>
			<div class="formula">
				{#if model}
					Trend(t) = {model.intercept.toFixed(4)} + {model.slope.toFixed(6)} × t (t=距{model.baseDate}天数)
				{:else}
					Trend(t) = …
				{/if}
			</div>
			<div class="levels">
				{#each LEVELS as lv (lv.id)}
					{@const LevelIcon = lv.icon}
					<div class="level-row">
						<span class="level-label">
							<LevelIcon size={14} color={lv.color} />
							{lv.label}
						</span>
						<span class="level-value {lv.cls}">
							{levelValues ? levelValues[lv.id].toFixed(3) : '--'}
						</span>
					</div>
				{/each}
			</div>
		</div>

		<div class="card">
			<div class="card-title"><Target size={15} /> 日内做T阈值</div>
			<div class="t-thresholds">
				<div class="t-card">
					<div class="t-val" style="color:var(--buy);">0.40%</div>
					<div class="t-label">低估区<br />跌≥0.40% → 加仓</div>
				</div>
				<div class="t-card">
					<div class="t-val" style="color:var(--sell);">0.40%</div>
					<div class="t-label">高估区<br />涨≥0.40% → 减仓</div>
				</div>
				<div class="t-card">
					<div class="t-val" style="color:var(--accent);">0.50%</div>
					<div class="t-label">正常区<br />±0.50% → 做T</div>
				</div>
			</div>
			<div class="advice-box" style="margin-top:12px;font-size:0.8rem;">
				<b>铁律：</b>正常区做T，无论盈亏，<b>收盘前必须把T出去的仓位平回来</b
				>。低估区加仓可持有，高估区减仓不追回。
			</div>
		</div>
	</div>

	<div class="card" style="margin-top:16px;">
		<div class="card-title"><ChartLine size={15} /> 历史走势与趋势通道</div>
		<div class="chart-container">
			{#if history.length}
				<canvas bind:this={chartCanvas}></canvas>
			{:else}
				<p class="placeholder">图表加载中…</p>
			{/if}
		</div>
	</div>

	<div class="card" style="margin-top:16px;">
		<div class="card-title"><Keyboard size={15} /> 手动输入价格（当自动获取失败时使用）</div>
		<div class="input-group">
			<input
				type="number"
				bind:value={manualPrice}
				placeholder="输入当前价格，如 1.470"
				step="0.001"
				onkeydown={(e) => e.key === 'Enter' && applyManualPrice()}
			/>
			<button class="btn" onclick={applyManualPrice}>应用</button>
		</div>
		<div class="refresh-info">
			自动获取源：新浪API → 腾讯API（经服务端代理，无跨域限制）| 若全部失败请使用手动输入
		</div>
	</div>

	<div class="card" style="margin-top:16px;">
		<div class="card-title"><ClipboardList size={15} /> 交易纪律速查</div>
		<ol class="rules">
			<li><b>每日开盘前</b>：计算今日五条关键价格（趋势值、高低估线）</li>
			<li>
				<b>低估区</b>（价格 &lt; 低估线）：日内每跌0.40%（相对开盘）→ <b>加仓</b>，收盘前保持加仓
			</li>
			<li>
				<b>高估区</b>（价格 &gt; 高估线）：日内每涨0.40%（相对开盘）→ <b>减仓</b>，收盘前保持减仓
			</li>
			<li><b>正常区间</b>：跌0.50%买入，涨0.50%卖出 → <b>做T</b>，尾盘必须平回仓位</li>
			<li><b>极端区间</b>（触及1%/99%线）：大幅加仓/减仓，不犹豫</li>
		</ol>
	</div>
</div>

<style>
	:global(:root) {
		--bg: #0f172a;
		--card: #1e293b;
		--text: #e2e8f0;
		--muted: #94a3b8;
		--accent: #38bdf8;
		--buy: #22c55e;
		--sell: #ef4444;
		--warn: #f59e0b;
		--border: #334155;
	}
	:global(*) {
		box-sizing: border-box;
		margin: 0;
		padding: 0;
	}
	:global(body) {
		background: var(--bg);
		color: var(--text);
		font-family:
			-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
		line-height: 1.6;
		padding: 20px;
	}
	.container {
		max-width: 1200px;
		margin: 0 auto;
	}
	h1 {
		font-size: 1.5rem;
		margin-bottom: 4px;
		display: flex;
		align-items: center;
		gap: 8px;
	}
	.title-icon {
		color: var(--accent);
	}
	.subtitle {
		color: var(--muted);
		font-size: 0.9rem;
		margin-bottom: 20px;
	}

	.grid {
		display: grid;
		gap: 16px;
	}
	@media (min-width: 768px) {
		.grid-3 {
			grid-template-columns: 1fr 1fr 1fr;
		}
		.grid-2 {
			grid-template-columns: 1fr 1fr;
		}
	}

	.card {
		background: var(--card);
		border: 1px solid var(--border);
		border-radius: 12px;
		padding: 16px;
	}
	.card-title {
		font-size: 0.85rem;
		color: var(--muted);
		text-transform: uppercase;
		letter-spacing: 0.05em;
		margin-bottom: 8px;
		display: flex;
		align-items: center;
		gap: 6px;
	}
	.big-number {
		font-size: 2rem;
		font-weight: 700;
	}
	.big-number.buy {
		color: var(--buy);
	}
	.big-number.sell {
		color: var(--sell);
	}
	.big-number.neutral {
		color: var(--accent);
	}
	.tag {
		display: inline-block;
		padding: 4px 10px;
		border-radius: 20px;
		font-size: 0.75rem;
		font-weight: 600;
		margin-top: 6px;
	}
	.tag-buy {
		background: rgba(34, 197, 94, 0.15);
		color: var(--buy);
	}
	.tag-sell {
		background: rgba(239, 68, 68, 0.15);
		color: var(--sell);
	}
	.tag-neutral {
		background: rgba(56, 189, 248, 0.15);
		color: var(--accent);
	}
	.tag-warn {
		background: rgba(245, 158, 11, 0.15);
		color: var(--warn);
	}

	.status-bar {
		display: flex;
		align-items: center;
		gap: 12px;
		margin-bottom: 16px;
		flex-wrap: wrap;
	}
	.status-indicator {
		width: 10px;
		height: 10px;
		border-radius: 50%;
		animation: pulse 2s infinite;
	}
	@keyframes pulse {
		0%,
		100% {
			opacity: 1;
		}
		50% {
			opacity: 0.4;
		}
	}

	.advice-box {
		background: rgba(56, 189, 248, 0.08);
		border-left: 4px solid var(--accent);
		padding: 14px;
		border-radius: 0 8px 8px 0;
		margin-top: 12px;
	}
	.advice-box.buy-zone {
		background: rgba(34, 197, 94, 0.08);
		border-left-color: var(--buy);
	}
	.advice-box.sell-zone {
		background: rgba(239, 68, 68, 0.08);
		border-left-color: var(--sell);
	}
	.advice-title {
		display: flex;
		align-items: center;
		gap: 6px;
		font-weight: 700;
		margin-bottom: 4px;
	}
	.advice-box p {
		font-size: 0.9rem;
	}

	.formula {
		font-family: 'SF Mono', Monaco, 'Cascadia Code', monospace;
		font-size: 0.8rem;
		background: rgba(15, 23, 42, 0.6);
		padding: 10px 14px;
		border-radius: 8px;
		margin-top: 8px;
		color: #a5b4fc;
	}

	.levels {
		margin-top: 12px;
	}
	.level-row {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 6px 0;
		border-bottom: 1px solid rgba(51, 65, 85, 0.5);
	}
	.level-row:last-child {
		border-bottom: none;
	}
	.level-label {
		font-size: 0.85rem;
		color: var(--muted);
		display: flex;
		align-items: center;
		gap: 6px;
	}
	.level-value {
		font-family: monospace;
		font-weight: 600;
	}
	.level-value.exhigh {
		color: #f87171;
	}
	.level-value.high {
		color: #fb923c;
	}
	.level-value.trend {
		color: var(--accent);
	}
	.level-value.low {
		color: #4ade80;
	}
	.level-value.exlow {
		color: #22c55e;
	}

	.chart-container {
		position: relative;
		height: 380px;
		margin-top: 16px;
	}
	.placeholder {
		color: var(--muted);
		font-size: 0.9rem;
		display: flex;
		align-items: center;
		justify-content: center;
		height: 100%;
	}

	.input-group {
		display: flex;
		gap: 8px;
		margin-top: 10px;
	}
	.input-group input {
		flex: 1;
		background: var(--bg);
		border: 1px solid var(--border);
		color: var(--text);
		padding: 8px 12px;
		border-radius: 8px;
		font-size: 1rem;
	}
	.btn {
		background: var(--accent);
		color: #0f172a;
		border: none;
		padding: 8px 18px;
		border-radius: 8px;
		font-weight: 600;
		cursor: pointer;
		transition: opacity 0.2s;
		display: inline-flex;
		align-items: center;
		gap: 6px;
	}
	.btn:hover {
		opacity: 0.85;
	}
	.btn-secondary {
		background: var(--border);
		color: var(--text);
	}
	.btn-sm {
		font-size: 0.75rem;
		padding: 4px 12px;
	}

	.rules {
		font-size: 0.85rem;
		line-height: 1.8;
		padding-left: 20px;
	}
	.rules li {
		margin-bottom: 6px;
	}

	.refresh-info {
		font-size: 0.75rem;
		color: var(--muted);
		margin-top: 6px;
	}

	.progress-bar {
		width: 100%;
		height: 6px;
		background: var(--border);
		border-radius: 3px;
		margin-top: 8px;
		overflow: hidden;
		position: relative;
	}
	.progress-fill {
		height: 100%;
		border-radius: 3px;
		transition: width 0.5s ease;
	}

	.t-thresholds {
		display: grid;
		grid-template-columns: repeat(3, 1fr);
		gap: 10px;
		margin-top: 10px;
	}
	.t-card {
		background: rgba(15, 23, 42, 0.5);
		border-radius: 8px;
		padding: 10px;
		text-align: center;
	}
	.t-card .t-val {
		font-size: 1.2rem;
		font-weight: 700;
	}
	.t-card .t-label {
		font-size: 0.7rem;
		color: var(--muted);
		margin-top: 4px;
	}

	.debug-info {
		font-size: 0.7rem;
		color: var(--muted);
		font-family: monospace;
		margin-top: 4px;
	}
</style>
