/**
 * 稳定性实验：Top5 做T方案 × 随机起点 × 持有1年，比较年化收益稳定性
 *
 * 方案来源：20261020-t-sizing 实验收益率前5（均为注资5w档）：
 *   shares_固定1万股(原方案) 38.61% / pct_仓位50% 36.19% / amount_固定1万元 35.03%
 *   / shares_固定5000股 29.32% / amount_固定5000元 27.36%
 * 规则与 t-sizing.mjs 完全一致（循环额度5w、清仓等待、费用、信号），仅区间变为随机起点1年。
 *
 * 随机起点：全部有效建仓日（信号就绪且能持满250个交易日，与 rolling-1y 同源，
 * 2024-10-28 ~ 2025-09-30 共230个）中，固定种子不放回抽样 N=100 个，逐年模拟持有 250 个
 * 交易日，按日历天数年化。
 *
 * 稳定性指标：年化均值/中位数/标准差/极值、P(年化<0)、P(年化>10%)、P(年化>20%)、均值/标准差。
 * 附纯持有1万股参照（不做T、不用额度）。
 *
 * 用法: node scripts/stability.mjs [输出目录，默认 backtest/20261020-stability/] [样本数N，默认 100]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const START_DATE = '2024-09-01'; // 建模起点（与看板及历次实验一致）
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
const BASE_SHARES = 10000;
const INIT_CASH = 10000;
const CAP = 50000; // Top5 均来自注资5w档
const HOLD_DAYS = 250;
const SEED = 20261020;

const OUT_DIR = process.argv[2] ? resolve(ROOT, process.argv[2]) : join(ROOT, 'backtest', '20261020-stability');
const N_SAMPLES = parseInt(process.argv[3] ?? '100', 10);

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const fee = (amount) => Math.max(COMMISSION_MIN, amount * COMMISSION_RATE);
const lot = (x) => Math.max(100, Math.floor(x / 100) * 100);

// —— Top5 方案（t-sizing 实验收益率前5，注资5w档；规则完全一致）——
const TOP5 = [
	{ name: 'shares_固定1万股(原方案)', type: 'shares', unit: 10000, clearWait: false },
	{ name: 'pct_仓位50%', type: 'pct', pct: 0.5, clearWait: true },
	{ name: 'amount_固定1万元', type: 'amount', amount: 10000, clearWait: true },
	{ name: 'shares_固定5000股', type: 'shares', unit: 5000, clearWait: true },
	{ name: 'amount_固定5000元', type: 'amount', amount: 5000, clearWait: true }
];

function qtyOf(s, shares, price) {
	if (s.type === 'shares') return s.unit;
	if (s.type === 'pct') return lot((shares > 0 ? shares : BASE_SHARES) * s.pct);
	if (s.type === 'amount') return lot(s.amount / price);
	return 0;
}

/** 固定种子伪随机（mulberry32），保证可复现 */
function rng(seed) {
	let a = seed >>> 0;
	return () => {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

async function getJSON(url) {
	const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
	if (!res.ok) throw new Error(`请求失败 ${res.status}: ${url}`);
	return res.json();
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

/** 与 stock.ts 一致的近期加权模型拟合 */
function fitWeighted(weeks) {
	const xs = weeks.map((w) => w.t);
	const ys = weeks.map((w) => w.price);
	const n = xs.length;
	const ws = xs.map((x) => 0.5 ** ((xs[n - 1] - x) / 7 / HALF_LIFE_WEEKS));
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
	return {
		trend: (t) => intercept + slope * t,
		high95: weightedQuantile(res, ws, 0.95),
		low05: weightedQuantile(res, ws, 0.05),
		high99: weightedQuantile(res, ws, 0.99),
		low01: weightedQuantile(res, ws, 0.01)
	};
}

function zoneOf(price, fit, t) {
	const tr = fit.trend(t);
	if (price < tr + fit.low01) return 'extreme_low';
	if (price < tr + fit.low05) return 'low';
	if (price > tr + fit.high99) return 'extreme_high';
	if (price > tr + fit.high95) return 'high';
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
	const amps = [];

	// —— 逐日预计算信号（与 t-sizing/backtest 判定顺序一致，仅近期加权模型）——
	const signals = new Array(days.length).fill(null);
	for (let i = 0; i < days.length; i++) {
		const d = days[i];
		const weeks = allWeeks.filter((w) => w.date < d.date);
		if (weeks.length >= 8 && amps.length >= AMP_WINDOW) {
			const fit = fitWeighted(weeks);
			const t = dayNum(baseDate, d.date);
			const medianAmp = amps.slice(-AMP_WINDOW).sort((a, b) => a - b)[Math.floor(AMP_WINDOW / 2)];
			const normalT = clamp(medianAmp * NORMAL_K, NORMAL_MIN, NORMAL_MAX);
			const zoneT = clamp(normalT * ZONE_RATIO, ZONE_MIN, ZONE_MAX);
			const zone = zoneOf(d.open, fit, t);
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
			signals[i] = s;
		}
		const amp = d.open > 0 ? (d.high - d.low) / d.open : 0;
		if (amp > 0) amps.push(amp);
	}

	// —— 随机起点抽样：全部有效建仓日中不放回抽 N 个（固定种子）——
	const validStarts = [];
	for (let i = 0; i + HOLD_DAYS < days.length; i++) if (signals[i]) validStarts.push(i);
	const rand = rng(SEED);
	const picked = [...validStarts].sort(() => rand() - 0.5).slice(0, Math.min(N_SAMPLES, validStarts.length));

	// —— 逐起点 × 逐策略模拟持有 1 年 ——
	const run = (s, startIdx) => {
		let cash = INIT_CASH;
		let shares = BASE_SHARES;
		const endIdx = Math.min(startIdx + HOLD_DAYS, days.length) - 1;
		const affordable = (price, q) => cash - price * q - fee(price * q) >= -CAP;
		for (let i = startIdx; i <= endIdx; i++) {
			const sig = signals[i];
			if (!sig) continue;
			const d = days[i];
			const flat = shares === 0;
			if (sig.zoneBuy != null) {
				const q = qtyOf(s, shares, sig.zoneBuy);
				if (affordable(sig.zoneBuy, q)) {
					cash -= sig.zoneBuy * q + fee(sig.zoneBuy * q);
					shares += q;
				}
			} else if (sig.zoneSell != null && shares > 0) {
				const q = qtyOf(s, shares, sig.zoneSell);
				const sellQ = shares >= q ? q : s.clearWait ? shares : 0;
				if (sellQ > 0) {
					cash += sig.zoneSell * sellQ - fee(sig.zoneSell * sellQ);
					shares -= sellQ;
				}
			} else if (!flat || !s.clearWait) {
				if (sig.t1) {
					const q = qtyOf(s, shares, sig.t1.buy);
					if (affordable(sig.t1.buy, q)) {
						cash -= sig.t1.buy * q + fee(sig.t1.buy * q);
						cash += sig.t1.sell * q - fee(sig.t1.sell * q);
					}
				}
				if (sig.t2) {
					const q = qtyOf(s, shares, sig.t2.sell);
					if (shares >= 2 * q && affordable(sig.t2.buy, q)) {
						cash += sig.t2.sell * q - fee(sig.t2.sell * q);
						cash -= sig.t2.buy * q + fee(sig.t2.buy * q);
					}
				}
			}
		}
		return { cash, shares, endIdx };
	};

	const rows = [];
	for (const i of picked) {
		const d0 = days[i];
		const startEq = INIT_CASH + BASE_SHARES * d0.open;
		const calDays = dayNum(d0.date, days[Math.min(i + HOLD_DAYS, days.length) - 1].date);
		for (const s of TOP5) {
			const { cash, shares, endIdx } = run(s, i);
			const endEq = cash + shares * days[endIdx].close;
			const ann = (endEq / startEq) ** (365.25 / calDays) - 1;
			rows.push({ start: d0.date, end: days[endIdx].date, strategy: s.name, ret: +( (endEq / startEq - 1) * 100).toFixed(2), ann: +(ann * 100).toFixed(2) });
		}
		// 纯持有参照
		const endIdx = Math.min(i + HOLD_DAYS, days.length) - 1;
		const endEq = INIT_CASH + BASE_SHARES * days[endIdx].close;
		const ann = (endEq / startEq) ** (365.25 / calDays) - 1;
		rows.push({ start: d0.date, end: days[endIdx].date, strategy: 'hold_纯持有1万股(参照)', ret: +((endEq / startEq - 1) * 100).toFixed(2), ann: +(ann * 100).toFixed(2) });
	}

	// —— 汇总 ——
	const summarize = (name) => {
		const anns = rows.filter((r) => r.strategy === name).map((r) => r.ann).sort((a, b) => a - b);
		const n = anns.length;
		const mean = anns.reduce((a, b) => a + b, 0) / n;
		const std = Math.sqrt(anns.reduce((a, b) => a + (b - mean) ** 2, 0) / n);
		const pct = (p) => anns[Math.min(n - 1, Math.floor(p * n))];
		return {
			策略: name,
			样本数: n,
			'年化均值%': mean.toFixed(2),
			'年化中位数%': pct(0.5).toFixed(2),
			'标准差%': std.toFixed(2),
			'均值/标准差': (mean / std).toFixed(2),
			'最差%': anns[0].toFixed(2),
			'10分位%': pct(0.1).toFixed(2),
			'90分位%': pct(0.9).toFixed(2),
			'最好%': anns[n - 1].toFixed(2),
			'P(亏损)': ((anns.filter((a) => a < 0).length / n) * 100).toFixed(1) + '%',
			'P(>10%)': ((anns.filter((a) => a > 10).length / n) * 100).toFixed(1) + '%',
			'P(>20%)': ((anns.filter((a) => a > 20).length / n) * 100).toFixed(1) + '%'
		};
	};
	const summary = [...TOP5.map((s) => s.name), 'hold_纯持有1万股(参照)'].map(summarize);

	// —— 输出 ——
	mkdirSync(OUT_DIR, { recursive: true });
	const csv = [
		'start,end,strategy,return_pct,annualized_pct',
		...rows.map((r) => `${r.start},${r.end},${r.strategy},${r.ret},${r.ann}`)
	].join('\n');
	writeFileSync(join(OUT_DIR, 'samples.csv'), csv + '\n');
	const report = {
		实验: 'Top5 做T方案稳定性：随机起点×持有1年×100样本（固定种子20261020，不放回抽样）',
		方案来源: '20261020-t-sizing 收益率前5（注资5w档），规则与 t-sizing.mjs 完全一致',
		起点范围: `${days[validStarts[0]].date} ~ ${days[validStarts.at(-1)].date}（有效建仓日 ${validStarts.length} 个，数据所限 2024-10 起）`,
		持有: `${HOLD_DAYS} 个交易日，按日历天数年化`,
		初始本金: `${BASE_SHARES}股 + ${INIT_CASH}元现金，循环注资额度${CAP / 10000}w`,
		summary,
		稳定性结论: '按 均值/标准差 排序（越高越稳），结合 P(亏损) 与分位区间判断',
	};
	writeFileSync(join(OUT_DIR, 'report.json'), JSON.stringify(report, null, 2) + '\n');

	console.log(`起点范围: ${days[validStarts[0]].date} ~ ${days[validStarts.at(-1)].date}（有效 ${validStarts.length} 个）→ 抽样 ${picked.length} 个`);
	console.log(`持有 ${HOLD_DAYS} 个交易日按日历年化；额度 ${CAP / 10000}w；种子 ${SEED}\n`);
	console.table(summary);
	console.log(`\n输出: ${OUT_DIR}/{samples.csv, report.json}`);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
