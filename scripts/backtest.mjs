/**
 * 双账户严格回测：近期加权模型 vs 等权全样本模型
 *
 * 规则（与看板操作计划一致，绝对严格执行）：
 * - 每天开盘判定区域（用 t 日之前已完成周K拟合的模型，无未来数据）
 * - 低估区：日内相对开盘跌 ≥ zoneT → 买入，收盘保持（不T出）
 * - 高估区：日内相对开盘涨 ≥ zoneT → 卖出底仓，收盘保持（不追回）
 * - 正常区：双边做T —— 跌 ≥ normalT 买入一份，尾盘前涨 ≥ normalT 卖出否则收盘卖出；
 *           涨 ≥ normalT 卖出一份（用底仓），尾盘前跌 ≥ normalT 买回否则收盘买回
 * - 极端区：按低估/高估区同等规则执行
 * - 做T阈值与看板一致：近20日日内振幅中位数 × 0.45（0.50%~1.00%），高低估区为其0.8倍
 * - 费用：佣金万二、最低5元，卖出无印花税（ETF），无滑点
 *
 * 用法: node scripts/backtest.mjs [起始日期，默认 2025-01-01] [输出目录，默认 backtest/]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const START_DATE = '2024-09-01'; // 建模起点（与看板一致）
const HALF_LIFE_WEEKS = 26;
const AMP_WINDOW = 20;
const NORMAL_K = 0.45;
const NORMAL_MIN = 0.005;
const NORMAL_MAX = 0.01;
const ZONE_RATIO = 0.8;
const ZONE_MIN = 0.004;
const ZONE_MAX = 0.008;
const COMMISSION_RATE = 0.0002;
const COMMISSION_MIN = 5;
const UNIT = 10000; // 每份股数（做T单位 = 底仓单位）

const BT_START = process.argv[2] ?? '2025-01-01';
const OUT_DIR = process.argv[3] ? resolve(ROOT, process.argv[3]) : join(ROOT, 'backtest');

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const fee = (amount) => Math.max(COMMISSION_MIN, amount * COMMISSION_RATE);

async function getJSON(url) {
	const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
	if (!res.ok) throw new Error(`请求失败 ${res.status}: ${url}`);
	return res.json();
}

function quantile(sorted, p) {
	const n = sorted.length;
	const pos = (n - 1) * p;
	const base = Math.floor(pos);
	const rest = pos - base;
	return sorted[base] + rest * ((sorted[base + 1] ?? sorted[base]) - sorted[base]);
}

function weightedQuantile(values, weights, p) {
	const order = values.map((v, i) => [v, weights[i]]).sort((a, b) => a[0] - b[0]);
	const total = weights.reduce((a, b) => a + b, 0);
	let acc = 0;
	for (const [v, w] of order) {
		acc += w;
		if (acc / total >= p) return v;
	}
	return order[order.length - 1][0];
}

/** 与 stock.ts 一致的双模型拟合，输入为截至当前的周K收盘 */
function fitModels(weeks) {
	const xs = weeks.map((w) => w.t);
	const ys = weeks.map((w) => w.price);
	const n = xs.length;
	const fit = (ws, weighted) => {
		const W = ws.reduce((a, b) => a + b, 0);
		const mx = ws.reduce((a, w, i) => a + w * xs[i], 0) / W;
		const my = ws.reduce((a, w, i) => a + w * ys[i], 0) / W;
		let num = 0;
		let den = 0;
		for (let i = 0; i < n; i++) {
			num += ws[i] * (xs[i] - mx) * (ys[i] - my);
			den += ws[i] * (xs[i] - mx) ** 2;
		}
		const slope = den === 0 ? 0 : num / den;
		const intercept = my - slope * mx;
		const res = ys.map((y, i) => y - (intercept + slope * xs[i]));
		const sorted = [...res].sort((a, b) => a - b);
		const bands = weighted
			? {
					high95: weightedQuantile(res, ws, 0.95),
					low05: weightedQuantile(res, ws, 0.05),
					high99: weightedQuantile(res, ws, 0.99),
					low01: weightedQuantile(res, ws, 0.01)
				}
			: {
					high95: quantile(sorted, 0.95),
					low05: quantile(sorted, 0.05),
					high99: quantile(sorted, 0.99),
					low01: quantile(sorted, 0.01)
				};
		return { intercept, slope, bands };
	};
	const weights = xs.map((x) => 0.5 ** ((xs[n - 1] - x) / 7 / HALF_LIFE_WEEKS));
	return { weighted: fit(weights, true), unweighted: fit(new Array(n).fill(1), false) };
}

function zoneOf(price, b) {
	const t = b.trend;
	if (price < t + b.bands.low01) return 'extreme_low';
	if (price < t + b.bands.low05) return 'low';
	if (price > t + b.bands.high99) return 'extreme_high';
	if (price > t + b.bands.high95) return 'high';
	return 'normal';
}

async function main() {
	const [wData, dData] = await Promise.all([
		getJSON('https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=sh515180,week,,,400,qfq'),
		getJSON('https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=sh515180,day,,,640,qfq')
	]);
	const wrows = wData.data.sh515180.qfqweek ?? wData.data.sh515180.week;
	const drows = dData.data.sh515180.qfqday ?? dData.data.sh515180.day;

	// 周K（含建模起点之前的数据用于 t 计算？t 以首个 >= START_DATE 的周为基准，与看板一致）
	const allWeeks = wrows
		.filter((r) => r[0] >= START_DATE)
		.map((r) => ({ date: r[0], price: parseFloat(r[2]) }));
	const baseDate = allWeeks[0].date;
	const dayNum = (a, b) =>
		Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000);
	for (const w of allWeeks) w.t = dayNum(baseDate, w.date);

	const days = drows
		.filter((r) => r[0] >= BT_START)
		.map((r) => ({
			date: r[0],
			open: parseFloat(r[1]),
			close: parseFloat(r[2]),
			high: parseFloat(r[3]),
			low: parseFloat(r[4])
		}));
	if (days.length < 20) throw new Error('回测区间日K不足');
	const ampHistory = drows
		.filter((r) => r[0] < BT_START)
		.map((r) => {
			const o = parseFloat(r[1]);
			return o > 0 ? (parseFloat(r[3]) - parseFloat(r[4])) / o : 0;
		})
		.filter((a) => a > 0);

	// 两个虚拟账户：10000 股底仓 + 10000 元现金起步，唯一差别是所用模型
	const mk = (name) => ({
		name,
		cash: 10000,
		shares: UNIT, // 底仓
		trades: [],
		equity: []
	});
	const accounts = [mk('weighted'), mk('unweighted')];

	const log = (acc, date, action, price, shares, note) =>
		acc.trades.push({ date, action, price: +price.toFixed(4), shares, note });

	const buy = (acc, date, price, shares, note) => {
		const f = fee(price * shares);
		acc.cash -= price * shares + f;
		acc.shares += shares;
		log(acc, date, '买入', price, shares, note);
	};
	const sell = (acc, date, price, shares, note) => {
		const f = fee(price * shares);
		acc.cash += price * shares - f;
		acc.shares -= shares;
		log(acc, date, '卖出', price, shares, note);
	};

	for (const d of days) {
		// —— 只用 d 之前已完成周K拟合（rowDate < d），无未来函数 ——
		const weeks = allWeeks.filter((w) => w.date < d.date);
		if (weeks.length < 8) continue; // 样本太少不交易，只记权益
		const models = fitModels(weeks);
		const t = dayNum(baseDate, d.date);

		// 动态阈值：d 之前近20日振幅中位数
		const amps = ampHistory.slice(-AMP_WINDOW);
		const medianAmp = amps.slice().sort((a, b) => a - b)[Math.floor(amps.length / 2)];
		const normalT = clamp(medianAmp * NORMAL_K, NORMAL_MIN, NORMAL_MAX);
		const zoneT = clamp(normalT * ZONE_RATIO, ZONE_MIN, ZONE_MAX);
		ampHistory.push((d.high - d.low) / d.open); // 当日收盘后进入历史

		for (const acc of accounts) {
			const fit = acc.name === 'weighted' ? models.weighted : models.unweighted;
			const b = {
				trend: fit.intercept + fit.slope * t,
				bands: fit.bands
			};
			const zone = zoneOf(d.open, b);
			const buyTrig = d.open * (1 - normalT);
			const sellTrig = d.open * (1 + normalT);
			const zoneBuyTrig = d.open * (1 - zoneT);
			const zoneSellTrig = d.open * (1 + zoneT);

			if (zone === 'low' || zone === 'extreme_low') {
				// 跌够阈值即加仓并持有
				if (d.low <= zoneBuyTrig && acc.cash >= zoneBuyTrig * UNIT) {
					buy(acc, d.date, zoneBuyTrig, UNIT, `${zone} 跌${(zoneT * 100).toFixed(2)}%加仓`);
				}
			} else if (zone === 'high' || zone === 'extreme_high') {
				// 涨够阈值即减仓并保持
				if (d.high >= zoneSellTrig && acc.shares >= UNIT) {
					sell(acc, d.date, zoneSellTrig, UNIT, `${zone} 涨${(zoneT * 100).toFixed(2)}%减仓`);
				}
			} else {
				// 正常区双边做T，尾盘强制平回
				if (d.low <= buyTrig && acc.cash >= buyTrig * UNIT) {
					const exit = d.high >= sellTrig ? sellTrig : d.close;
					buy(acc, d.date, buyTrig, UNIT, `做T买 跌${(normalT * 100).toFixed(2)}%`);
					sell(acc, d.date, exit, UNIT, exit === d.close ? '做T卖 尾盘平回' : '做T卖 达到对侧阈值');
				}
				if (d.high >= sellTrig && acc.shares >= UNIT * 2) {
					// 底仓之上需有可用份额（底仓10000 + 当日买入的10000已平回）
					const exit = d.low <= buyTrig ? buyTrig : d.close;
					sell(acc, d.date, sellTrig, UNIT, `反T卖 涨${(normalT * 100).toFixed(2)}%`);
					buy(acc, d.date, exit, UNIT, exit === d.close ? '反T买 尾盘回补' : '反T买 达到对侧阈值');
				}
			}

			acc.equity.push({
				date: d.date,
				close: d.close,
				equity: +(acc.cash + acc.shares * d.close).toFixed(2),
				zone
			});
		}
	}

	// —— 输出 ——
	mkdirSync(OUT_DIR, { recursive: true });
	const [w, u] = accounts;
	const csvE = [
		'date,close,weighted_equity,weighted_zone,unweighted_equity,unweighted_zone',
		...w.equity.map(
			(e, i) =>
				`${e.date},${e.close},${e.equity},${e.zone},${u.equity[i].equity},${u.equity[i].zone}`
		)
	].join('\n');
	writeFileSync(join(OUT_DIR, 'equity.csv'), csvE + '\n');

	const csvT = [
		'account,date,action,price,shares,note',
		...accounts.flatMap((a) =>
			a.trades.map((tr) => `${a.name},${tr.date},${tr.action},${tr.price},${tr.shares},${tr.note}`)
		)
	].join('\n');
	writeFileSync(join(OUT_DIR, 'trades.csv'), csvT + '\n');

	const report = accounts.map((a) => {
		const startEq = a.equity[0]?.equity ?? 0;
		const endEq = a.equity[a.equity.length - 1]?.equity ?? 0;
		const tPairs = a.trades.filter((tr) => tr.note.startsWith('做T') || tr.note.startsWith('反T'));
		void tPairs;
		// 按"买/卖"配对计算做T盈亏
		let tProfit = 0;
		let tWin = 0;
		let tCount = 0;
		for (let i = 0; i < a.trades.length - 1; i++) {
			const cur = a.trades[i];
			const nxt = a.trades[i + 1];
			const isT =
				(cur.note.startsWith('做T') || cur.note.startsWith('反T')) &&
				(nxt.note.startsWith('做T') || nxt.note.startsWith('反T')) &&
				nxt.date === cur.date;
			if (!isT) continue;
			const p =
				cur.action === '买入'
					? (nxt.price - cur.price) * cur.shares
					: (cur.price - nxt.price) * cur.shares;
			const f = fee(cur.price * cur.shares) + fee(nxt.price * cur.shares);
			tProfit += p - f;
			tCount++;
			if (p - f > 0) tWin++;
		}
		return {
			account: a.name,
			trades: a.trades.length,
			tCount,
			tWinRate: tCount ? ((tWin / tCount) * 100).toFixed(1) + '%' : '-',
			tProfit: tProfit.toFixed(2),
			startEquity: startEq,
			endEquity: endEq,
			returnPct: (((endEq - startEq) / startEq) * 100).toFixed(2) + '%'
		};
	});
	writeFileSync(join(OUT_DIR, 'report.json'), JSON.stringify(report, null, 2) + '\n');

	console.log(
		`回测区间: ${days[0].date} ~ ${days[days.length - 1].date} (${days.length} 个交易日)`
	);
	console.table(report);
	console.log(`\n输出: ${OUT_DIR}/equity.csv, trades.csv, report.json`);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
