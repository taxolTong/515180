/**
 * 滚动建仓回测：过去任意一个交易日建仓（10000股底仓 + 10000元现金，与严格回测一致），
 * 坚持交易纪律持有 250 个交易日（≈1年），统计年化收益分布：
 * 中位数/均值/极值、P(年化>15%)、P(年化<10%)。
 *
 * 交易规则、阈值、费用与 scripts/backtest.mjs 完全一致；信号按日预计算，避免重复拟合。
 *
 * 用法: node scripts/rolling.mjs [持有天数，默认 250] [输出目录，默认 backtest/rolling/]
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
const UNIT = 10000; // 每份股数

const HOLD_DAYS = parseInt(process.argv[2] ?? '250', 10);
const OUT_DIR = process.argv[3] ? resolve(ROOT, process.argv[3]) : join(ROOT, 'backtest', 'rolling');

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

/** 与 stock.ts / backtest.mjs 一致的双模型拟合 */
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

	const allWeeks = wrows
		.filter((r) => r[0] >= START_DATE)
		.map((r) => ({ date: r[0], price: parseFloat(r[2]) }));
	const baseDate = allWeeks[0].date;
	const dayNum = (a, b) =>
		Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000);
	for (const w of allWeeks) w.t = dayNum(baseDate, w.date);

	const days = drows.map((r) => ({
		date: r[0],
		open: parseFloat(r[1]),
		close: parseFloat(r[2]),
		high: parseFloat(r[3]),
		low: parseFloat(r[4])
	}));

	// —— 逐日预计算信号（与 backtest.mjs 同一天内判定顺序完全一致）——
	const amps = [];
	const signals = new Array(days.length).fill(null);
	for (let i = 0; i < days.length; i++) {
		const d = days[i];
		// 模型：只用 d 之前已完成周K（rowDate < d），无未来函数
		const weeks = allWeeks.filter((w) => w.date < d.date);
		if (weeks.length >= 8 && amps.length >= AMP_WINDOW) {
			const models = fitModels(weeks);
			const t = dayNum(baseDate, d.date);
			const medianAmp = amps.slice(-AMP_WINDOW).sort((a, b) => a - b)[Math.floor(AMP_WINDOW / 2)];
			const normalT = clamp(medianAmp * NORMAL_K, NORMAL_MIN, NORMAL_MAX);
			const zoneT = clamp(normalT * ZONE_RATIO, ZONE_MIN, ZONE_MAX);
			signals[i] = {};
			for (const name of ['weighted', 'unweighted']) {
				const fit = models[name];
				const b = { trend: fit.intercept + fit.slope * t, bands: fit.bands };
				const zone = zoneOf(d.open, b);
				const buyTrig = d.open * (1 - normalT);
				const sellTrig = d.open * (1 + normalT);
				const zoneBuyTrig = d.open * (1 - zoneT);
				const zoneSellTrig = d.open * (1 + zoneT);
				const s = { zone };
				if (zone === 'low' || zone === 'extreme_low') {
					s.zoneBuy = d.low <= zoneBuyTrig ? zoneBuyTrig : null;
				} else if (zone === 'high' || zone === 'extreme_high') {
					s.zoneSell = d.high >= zoneSellTrig ? zoneSellTrig : null;
				} else {
					s.t1 = d.low <= buyTrig ? { buy: buyTrig, sell: d.high >= sellTrig ? sellTrig : d.close } : null;
					s.t2 = d.high >= sellTrig ? { sell: sellTrig, buy: d.low <= buyTrig ? buyTrig : d.close } : null;
				}
				signals[i][name] = s;
			}
		}
		const amp = d.open > 0 ? (d.high - d.low) / d.open : 0;
		if (amp > 0) amps.push(amp);
	}

	// —— 滚动建仓：每个有效交易日为起点，模拟持有 HOLD_DAYS 天 ——
	const run = (startIdx, model) => {
		let cash = 10000;
		let shares = UNIT;
		for (let i = startIdx; i < startIdx + HOLD_DAYS && i < days.length; i++) {
			const s = signals[i]?.[model];
			if (!s) continue;
			const date = days[i].date;
			if (s.zoneBuy != null && cash >= s.zoneBuy * UNIT) {
				cash -= s.zoneBuy * UNIT + fee(s.zoneBuy * UNIT);
				shares += UNIT;
			} else if (s.zoneSell != null && shares >= UNIT) {
				cash += s.zoneSell * UNIT - fee(s.zoneSell * UNIT);
				shares -= UNIT;
			} else {
				if (s.t1 && cash >= s.t1.buy * UNIT) {
					cash -= s.t1.buy * UNIT + fee(s.t1.buy * UNIT);
					shares += UNIT;
					cash += s.t1.sell * UNIT - fee(s.t1.sell * UNIT);
					shares -= UNIT;
				}
				if (s.t2 && shares >= UNIT * 2) {
					cash += s.t2.sell * UNIT - fee(s.t2.sell * UNIT);
					shares -= UNIT;
					cash -= s.t2.buy * UNIT + fee(s.t2.buy * UNIT);
					shares += UNIT;
				}
			}
			void date;
		}
		const endIdx = Math.min(startIdx + HOLD_DAYS, days.length) - 1;
		return { cash, shares, endIdx };
	};

	const results = { weighted: [], unweighted: [] };
	for (let i = 0; i + HOLD_DAYS < days.length; i++) {
		if (!signals[i]) continue; // 起点当天需可用信号（模型+阈值就绪）
		const d0 = days[i];
		const startEq = 10000 + UNIT * d0.open;
		for (const model of ['weighted', 'unweighted']) {
			const { cash, shares, endIdx } = run(i, model);
			const endEq = cash + shares * days[endIdx].close;
			const calDays = dayNum(d0.date, days[endIdx].date);
			const ret = endEq / startEq - 1;
			const ann = (endEq / startEq) ** (365.25 / calDays) - 1;
			results[model].push({
				start: d0.date,
				end: days[endIdx].date,
				ret: +(ret * 100).toFixed(2),
				ann: +(ann * 100).toFixed(2)
			});
		}
	}

	// —— 输出 ——
	mkdirSync(OUT_DIR, { recursive: true });
	for (const model of ['weighted', 'unweighted']) {
		const rows = results[model];
		const csv = ['start,end,return_pct,annualized_pct', ...rows.map((r) => `${r.start},${r.end},${r.ret},${r.ann}`)].join('\n');
		writeFileSync(join(OUT_DIR, `${model}.csv`), csv + '\n');
	}

	const summarize = (rows) => {
		const anns = rows.map((r) => r.ann).sort((a, b) => a - b);
		const n = anns.length;
		const pct = (p) => anns[Math.min(n - 1, Math.floor(p * n))];
		const ge15 = anns.filter((a) => a > 15).length / n;
		const lt10 = anns.filter((a) => a < 10).length / n;
		return {
			样本数: n,
			'年化中位数%': pct(0.5).toFixed(2),
			'年化均值%': (anns.reduce((a, b) => a + b, 0) / n).toFixed(2),
			'最差%': anns[0].toFixed(2),
			'10分位%': pct(0.1).toFixed(2),
			'25分位%': pct(0.25).toFixed(2),
			'75分位%': pct(0.75).toFixed(2),
			'90分位%': pct(0.9).toFixed(2),
			'最好%': anns[n - 1].toFixed(2),
			'P(年化>15%)': (ge15 * 100).toFixed(1) + '%',
			'P(年化<10%)': (lt10 * 100).toFixed(1) + '%'
		};
	};

	console.log(`建仓区间: ${results.weighted[0]?.start} ~ ${results.weighted.at(-1)?.start}`);
	console.log(`持有: ${HOLD_DAYS} 个交易日（按实际日历天数年化）\n`);
	console.log('近期加权模型:'); console.table(summarize(results.weighted));
	console.log('等权全样本模型:'); console.table(summarize(results.unweighted));
	console.log(`\n输出: ${OUT_DIR}/{weighted,unweighted}.csv`);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
