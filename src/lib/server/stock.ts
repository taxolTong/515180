import type { HistoryPoint, HistoryResponse, ModelFit, OptimizedModel, Quote, TSignal } from '$lib/types';
import { round } from '$lib/model';

const START_DATE = '2024-09-01';
const HISTORY_TTL = 60 * 60 * 1000; // 1h

// 近期走势加权（问题三）：半衰期 26 周，越近的数据权重越大，
// 让 924 牛市等早期行情对趋势与通道的影响随时间衰减。
const HALF_LIFE_WEEKS = 26;

// 动态做T阈值（问题二）：以近 20 个交易日的日内中位振幅为基准，
// 正常区阈值 = 振幅 × 0.45（下限 0.50%，上限 1.00%），高/低估区为其 0.8 倍（下限 0.40%，上限 0.80%）。
const AMP_WINDOW = 20;
const NORMAL_K = 0.45;
const NORMAL_MIN = 0.005;
const NORMAL_MAX = 0.01;
const ZONE_RATIO = 0.8;
const ZONE_MIN = 0.004;
const ZONE_MAX = 0.008;

// 模型三「B092 优化版」（20261027 实验全历史验证最优，backtest/20261027-models-full）：
// 通道放宽到残差 23%/77%（极端 2%/98%）；T 阈值 = 近60日振幅 Q0.33 × 0.58（限 0.4%~1.5%），
// 区触发 = T × 0.63（限 0.4%~1.2%）；T 单过夜：目标 +T×1.4、止损 −T×0.5、最长 5 日；每笔固定 1 万元。
const OPT_ZONE_P = 0.23;
const OPT_EXTREME_P = 0.02;
const OPT_AMP_WINDOW = 60;
const OPT_AMP_Q = 0.33;
const OPT_T_K = 0.58;
const OPT_T_MIN = 0.004;
const OPT_T_MAX = 0.015;
const OPT_ZONE_RATIO = 0.63;
const OPT_ZONE_MIN = 0.004;
const OPT_ZONE_MAX = 0.012;

let historyCache: { at: number; data: HistoryResponse } | null = null;

function quantile(sorted: number[], p: number): number {
	const n = sorted.length;
	if (n === 0) return 0;
	if (n === 1) return sorted[0];
	const pos = (n - 1) * p;
	const base = Math.floor(pos);
	const rest = pos - base;
	const lo = sorted[base];
	const hi = sorted[base + 1] ?? lo;
	return lo + rest * (hi - lo);
}

/** 加权分位数：按权重累积到 p 处取残差值 */
function weightedQuantile(values: number[], weights: number[], p: number): number {
	const order = values.map((v, i) => [v, weights[i]] as const).sort((a, b) => a[0] - b[0]);
	const total = weights.reduce((a, b) => a + b, 0);
	let acc = 0;
	for (const [v, w] of order) {
		acc += w;
		if (acc / total >= p) return v;
	}
	return order[order.length - 1][0];
}

function clamp(x: number, lo: number, hi: number): number {
	return Math.min(hi, Math.max(lo, x));
}

function daysBetween(a: string, b: string): number {
	return (new Date(b + 'T00:00:00Z').getTime() - new Date(a + 'T00:00:00Z').getTime()) / 86400000;
}

/** 拉取日K并返回日内振幅序列（(最高−最低)/开盘，正数，按时间正序） */
async function fetchDailyAmps(): Promise<number[]> {
	const url = 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=sh515180,day,,,320,qfq';
	const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
	if (!res.ok) throw new Error(`日K请求失败: ${res.status}`);
	const data = (await res.json()) as {
		data?: { sh515180?: { qfqday?: string[][]; day?: string[][] } };
	};
	const rows = data.data?.sh515180?.qfqday ?? data.data?.sh515180?.day ?? [];
	if (!rows.length) throw new Error('日K无数据');
	const amps = rows
		.map((r) => {
			const open = parseFloat(r[1]);
			return open > 0 ? (parseFloat(r[3]) - parseFloat(r[4])) / open : 0;
		})
		.filter((a) => a > 0);
	if (!amps.length) throw new Error('日K振幅数据不足');
	return amps;
}

async function fetchHistory(): Promise<HistoryResponse> {
	const url = 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=sh515180,week,,,400,qfq';
	const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
	if (!res.ok) throw new Error(`历史行情请求失败: ${res.status}`);
	const data = (await res.json()) as {
		data?: { sh515180?: { qfqweek?: string[][]; week?: string[][] } };
	};
	const node = data.data?.sh515180;
	// 问题一：历史建模统一使用前复权(qfq)周K。腾讯前复权以最新价为锚、
	// 除息日下调历史价，分红造成的跳空在序列内部已被抹平，与实时价可比。
	// 若接口未返回 qfqweek 而回退到未复权数据，必须亮出标志，避免分红后模型失真。
	const adjusted = !!node?.qfqweek && node.qfqweek.length > 0;
	const rows = node?.qfqweek ?? node?.week ?? [];
	if (!rows.length) throw new Error('历史行情无数据');

	// 腾讯周K格式: [日期, 开盘, 收盘, 最高, 最低, 成交量]
	const points = rows
		.filter((r) => r[0] >= START_DATE)
		.map((r) => ({ date: r[0], price: parseFloat(r[2]) }));

	if (points.length < 2) throw new Error('历史行情数据不足');

	const baseDate = points[0].date;
	const xs = points.map((p) => daysBetween(baseDate, p.date));
	const ys = points.map((p) => p.price);
	const n = points.length;

	// 双模型拟合（问题三）：同一批数据同时给出「近期加权」与「等权全样本」两套趋势线与通道，
	// 前端可切换查看；两套模型区域判断一致时信号可信度更高。
	const fit = (ws: number[], weighted: boolean) => {
		const W = ws.reduce((a, b) => a + b, 0);
		const meanX = ws.reduce((a, w, i) => a + w * xs[i], 0) / W;
		const meanY = ws.reduce((a, w, i) => a + w * ys[i], 0) / W;
		let num = 0;
		let den = 0;
		for (let i = 0; i < n; i++) {
			num += ws[i] * (xs[i] - meanX) * (ys[i] - meanY);
			den += ws[i] * (xs[i] - meanX) ** 2;
		}
		const slope = den === 0 ? 0 : num / den;
		const intercept = meanY - slope * meanX;
		const residuals = points.map((p, i) => p.price - (intercept + slope * xs[i]));
		const bands = weighted
			? {
					high95: round(weightedQuantile(residuals, ws, 0.95)),
					low05: round(weightedQuantile(residuals, ws, 0.05)),
					high99: round(weightedQuantile(residuals, ws, 0.99)),
					low01: round(weightedQuantile(residuals, ws, 0.01))
				}
			: {
					high95: round(
						quantile(
							[...residuals].sort((a, b) => a - b),
							0.95
						)
					),
					low05: round(
						quantile(
							[...residuals].sort((a, b) => a - b),
							0.05
						)
					),
					high99: round(
						quantile(
							[...residuals].sort((a, b) => a - b),
							0.99
						)
					),
					low01: round(
						quantile(
							[...residuals].sort((a, b) => a - b),
							0.01
						)
					)
				};
		return { intercept: round(intercept), slope: round(slope, 6), bands, residuals, weights: ws };
	};

	const weights = xs.map((x) => 0.5 ** ((xs[n - 1] - x) / 7 / HALF_LIFE_WEEKS));
	const weighted = fit(weights, true);
	const unweighted = fit(new Array(n).fill(1), false);
	const W = weights.reduce((a, b) => a + b, 0);
	const effectiveN = round((W * W) / weights.reduce((a, w) => a + w * w, 0), 1);

	// —— 模型三「B092 优化版」：沿用近期加权拟合，通道放宽到 23%/77%（极端 2%/98%） ——
	const optimizedFit: ModelFit = {
		intercept: weighted.intercept,
		slope: weighted.slope,
		bands: {
			high95: round(weightedQuantile(weighted.residuals, weighted.weights, 1 - OPT_ZONE_P)), // 77%
			low05: round(weightedQuantile(weighted.residuals, weighted.weights, OPT_ZONE_P)), // 23%
			high99: round(weightedQuantile(weighted.residuals, weighted.weights, 1 - OPT_EXTREME_P)), // 98%
			low01: round(weightedQuantile(weighted.residuals, weighted.weights, OPT_EXTREME_P)) // 2%
		}
	};

	// 动态做T阈值：原方案（近20日中位数）与 B092（近60日 Q0.33）
	const ampSeries = await fetchDailyAmps();
	const sorted = (arr: number[]) => [...arr].sort((a, b) => a - b);
	const medianAmp = (() => {
		const amps = sorted(ampSeries.slice(-AMP_WINDOW));
		return amps.length ? amps[Math.floor(amps.length / 2)] : 0;
	})();
	const normal = clamp(medianAmp * NORMAL_K, NORMAL_MIN, NORMAL_MAX);
	const zone = clamp(normal * ZONE_RATIO, ZONE_MIN, ZONE_MAX);
	const tSignal: TSignal = {
		normal: round(normal, 4),
		zone: round(zone, 4),
		medianAmp: round(medianAmp, 4),
		windowDays: AMP_WINDOW
	};

	const optAmpQ = quantile(sorted(ampSeries.slice(-OPT_AMP_WINDOW)), OPT_AMP_Q);
	const optNormal = clamp(optAmpQ * OPT_T_K, OPT_T_MIN, OPT_T_MAX);
	const optZone = clamp(optNormal * OPT_ZONE_RATIO, OPT_ZONE_MIN, OPT_ZONE_MAX);
	const optimized: OptimizedModel = {
		fit: optimizedFit,
		tSignal: {
			normal: round(optNormal, 4),
			zone: round(optZone, 4),
			medianAmp: round(optAmpQ, 4),
			windowDays: OPT_AMP_WINDOW
		}
	};

	const history: HistoryPoint[] = points.map((p) => ({ date: p.date, price: p.price }));

	return {
		baseDate,
		weighted,
		unweighted,
		optimized,
		adjusted,
		halfLifeWeeks: HALF_LIFE_WEEKS,
		effectiveN,
		tSignal,
		history
	};
}

export async function getHistory(): Promise<HistoryResponse> {
	if (historyCache && Date.now() - historyCache.at < HISTORY_TTL) return historyCache.data;
	const data = await fetchHistory();
	historyCache = { at: Date.now(), data };
	return data;
}

export async function getQuote(): Promise<Quote> {
	// 新浪
	try {
		const res = await fetch('https://hq.sinajs.cn/list=sh515180', {
			headers: { Referer: 'https://finance.sina.com.cn', 'User-Agent': 'Mozilla/5.0' }
		});
		if (res.ok) {
			const text = new TextDecoder('gbk').decode(await res.arrayBuffer());
			const m = text.match(/hq_str_sh515180="([^"]*)"/);
			if (m) {
				const p = m[1].split(',');
				if (p.length > 31) {
					const price = parseFloat(p[3]);
					const open = parseFloat(p[1]);
					const high = parseFloat(p[4]);
					const low = parseFloat(p[5]);
					if (price > 0) {
						return {
							price,
							open,
							high,
							low,
							name: p[0],
							source: '新浪',
							time: `${p[30]} ${p[31]}`
						};
					}
				}
			}
		}
	} catch {
		// 继续尝试腾讯
	}

	// 腾讯
	const res = await fetch('https://qt.gtimg.cn/q=sh515180', {
		headers: { 'User-Agent': 'Mozilla/5.0' }
	});
	if (!res.ok) throw new Error(`行情请求失败: ${res.status}`);
	const text = new TextDecoder('gbk').decode(await res.arrayBuffer());
	const m = text.match(/v_sh515180="([^"]*)"/);
	if (!m) throw new Error('行情解析失败');
	const p = m[1].split('~');
	const price = parseFloat(p[3]);
	const open = parseFloat(p[5]);
	const high = parseFloat(p[33]);
	const low = parseFloat(p[34]);
	if (!(price > 0)) throw new Error('行情数据无效');
	return { price, open, high, low, name: p[1], source: '腾讯', time: new Date().toLocaleString() };
}
