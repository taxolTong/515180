/**
 * 稳定性实验（全历史版）：Top5 做T方案 × 分散时间尺度 × 持有1年
 *
 * 背景：20261020-stability 受腾讯行情接口 640 条日K上限所限，实际只覆盖
 * 2024-10~2026-10 两年（230 个有效起点），样本全部落在同一段行情中，
 * 无法检验策略在牛熊不同环境下的稳定性。本脚本改用 iFinD 前复权日线
 * （20261022 拉取，2019-12-20 上市 ~ 2026-10-21 共 1654 条，已存
 * backtest/_data/515180_daily_all.csv），把起点分散到全历史区间重跑。
 *
 * 与 stability.mjs 的差异只有数据与抽样：
 *   - 周K由前复权日K按自然周聚合（周一首开盘价/周最高/周最低/周末收盘价），
 *     与腾讯 qfqweek 口径一致（2024-09 以来两家价格逐日核对完全一致）；
 *   - 起点改为按建仓年份分层抽样（各年样本数按有效起点占比分配，上限内取整），
 *     保证时间尺度分散；同一脚本先跑【复现校验】（仅取 2024-09-01 起数据、
 *     与原实验同种子同抽样法 N=100），确认换源后结果可复现，再跑【全历史】。
 *
 * 交易规则、信号、费用、额度、Top5 方案与 stability.mjs 逐行一致，不重述。
 *
 * 用法: node scripts/stability-full.mjs [输出目录，默认 backtest/20261022-stability-full/] [全历史样本数N，默认 200]
 */
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

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
const SEED_REPRO = 20261020; // 与原实验同种子（复现校验）
const SEED_FULL = 20261022; // 全历史分层抽样种子

const OUT_DIR = process.argv[2] ? resolve(ROOT, process.argv[2]) : join(ROOT, 'backtest', '20261022-stability-full');
const N_FULL = parseInt(process.argv[3] ?? '200', 10);
const DATA_FILE = join(ROOT, 'backtest', '_data', '515180_daily_all.csv');

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const fee = (amount) => Math.max(COMMISSION_MIN, amount * COMMISSION_RATE);
const lot = (x) => Math.max(100, Math.floor(x / 100) * 100);

// —— Top5 方案（与 stability.mjs 完全一致）——
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

/** 固定种子伪随机（mulberry32），与原脚本同实现保证抽样可复现 */
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

/** 读 iFinD 全历史前复权日线 CSV → { days, allWeeks }（weeks 由日K按周聚合） */
function loadData(startDate) {
	const lines = readFileSync(DATA_FILE, 'utf8').trim().split('\n');
	const days = [];
	for (const line of lines.slice(1)) {
		const [date, open, high, low, close] = line.split(',');
		if (date < startDate.replaceAll('-', '')) continue;
		days.push({
			date: `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`,
			open: parseFloat(open),
			high: parseFloat(high),
			low: parseFloat(low),
			close: parseFloat(close)
		});
	}
	// 按 ISO 自然周聚合：open=周一首开盘价，high/low=周内极值，close=周末收盘价
	const byWeek = new Map();
	for (const d of days) {
		const dt = new Date(d.date + 'T00:00:00Z');
		const day = (dt.getUTCDay() + 6) % 7; // 周一=0
		const monday = new Date(dt.getTime() - day * 86400000);
		const key = monday.toISOString().slice(0, 10);
		if (!byWeek.has(key)) byWeek.set(key, { date: d.date, price: d.close, open: d.open, high: d.high, low: d.low });
		const w = byWeek.get(key);
		w.date = d.date;
		w.price = d.close;
		w.high = Math.max(w.high, d.high);
		w.low = Math.min(w.low, d.low);
	}
	const allWeeks = [...byWeek.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
	return { days, allWeeks };
}

/** 逐日预计算信号（与 stability.mjs 判定顺序一致，仅近期加权模型） */
function buildSignals(days, allWeeks) {
	const baseDate = allWeeks[0].date;
	const dayNum = (a, b) =>
		Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000);
	for (const w of allWeeks) w.t = dayNum(baseDate, w.date);

	const signals = new Array(days.length).fill(null);
	const amps = [];
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
	return signals;
}

/** 单起点 × 单策略模拟（与 stability.mjs 逐行一致） */
function run(s, startIdx, days, signals) {
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
}

/** 汇总指标（与 stability.mjs 口径一致） */
function summarize(rows, name) {
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
}

/** 从有效起点集合跑一轮实验并返回 { rows, summary } */
function experiment(picked, days, signals, tag) {
	const dayNum = (a, b) =>
		Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000);
	const rows = [];
	for (const i of picked) {
		const d0 = days[i];
		const startEq = INIT_CASH + BASE_SHARES * d0.open;
		const endIdx = Math.min(i + HOLD_DAYS, days.length) - 1;
		const calDays = dayNum(d0.date, days[endIdx].date);
		for (const s of TOP5) {
			const { cash, shares, endIdx: e } = run(s, i, days, signals);
			const endEq = cash + shares * days[e].close;
			const ann = (endEq / startEq) ** (365.25 / calDays) - 1;
			rows.push({ tag, start: d0.date, end: days[e].date, strategy: s.name, ret: +((endEq / startEq - 1) * 100).toFixed(2), ann: +(ann * 100).toFixed(2) });
		}
		const endEq = INIT_CASH + BASE_SHARES * days[endIdx].close;
		const ann = (endEq / startEq) ** (365.25 / calDays) - 1;
		rows.push({ tag, start: d0.date, end: days[endIdx].date, strategy: 'hold_纯持有1万股(参照)', ret: +((endEq / startEq - 1) * 100).toFixed(2), ann: +(ann * 100).toFixed(2) });
	}
	const summary = [...TOP5.map((s) => s.name), 'hold_纯持有1万股(参照)'].map((n) => summarize(rows, n));
	return { rows, summary };
}

/** 不放回随机抽样（与原脚本 sort(() => rand() - 0.5) 同法，传同种子结果一致） */
function sampleUniform(validStarts, n, seed) {
	const rand = rng(seed);
	return [...validStarts].sort(() => rand() - 0.5).slice(0, Math.min(n, validStarts.length));
}

/** 按建仓年份分层抽样：各年名额 = N × 当年有效起点占比（四舍五入），层内不放回随机 */
function sampleStratified(validStarts, days, n, seed) {
	const byYear = new Map();
	for (const i of validStarts) {
		const y = days[i].date.slice(0, 4);
		if (!byYear.has(y)) byYear.set(y, []);
		byYear.get(y).push(i);
	}
	const rand = rng(seed);
	// 先按比例分配，剩余名额从最大层依次补
	const years = [...byYear.keys()].sort();
	const total = validStarts.length;
	let alloc = years.map((y) => ({ y, idx: byYear.get(y), quota: Math.round((n * byYear.get(y).length) / total) }));
	let used = alloc.reduce((a, b) => a + b.quota, 0);
	const order = [...alloc].sort((a, b) => b.idx.length - a.idx.length);
	let k = 0;
	while (used < n && k < order.length) {
		order[k % order.length].quota++;
		used++;
		k++;
	}
	while (used > n) {
		const big = order.find((a) => a.quota > 0);
		big.quota--;
		used--;
	}
	const picked = [];
	for (const { idx, quota } of alloc) {
		picked.push(...[...idx].sort(() => rand() - 0.5).slice(0, Math.min(quota, idx.length)));
	}
	return picked.sort((a, b) => a - b);
}

function main() {
	// —— 复现校验：数据与建模起点同原实验（2024-09-01 起），同种子同抽样法 N=100 ——
	const { days: daysR, allWeeks: weeksR } = loadData('2024-09-01');
	const sigR = buildSignals(daysR, weeksR);
	const validR = [];
	for (let i = 0; i + HOLD_DAYS < daysR.length; i++) if (sigR[i]) validR.push(i);
	const pickedR = sampleUniform(validR, 100, SEED_REPRO);
	const repro = experiment(pickedR, daysR, sigR, 'repro_2y');

	// —— 全历史：建模起点上市日 2019-12-20，起点分层抽样 N 个 ——
	const { days: daysF, allWeeks: weeksF } = loadData('2019-12-20');
	const sigF = buildSignals(daysF, weeksF);
	const validF = [];
	for (let i = 0; i + HOLD_DAYS < daysF.length; i++) if (sigF[i]) validF.push(i);
	const pickedF = sampleStratified(validF, daysF, Math.min(N_FULL, validF.length), SEED_FULL);
	const full = experiment(pickedF, daysF, sigF, 'full_all');

	// —— 输出 ——
	mkdirSync(OUT_DIR, { recursive: true });
	const allRows = [...repro.rows, ...full.rows];
	const csv = [
		'tag,start,end,strategy,return_pct,annualized_pct',
		...allRows.map((r) => `${r.tag},${r.start},${r.end},${r.strategy},${r.ret},${r.ann}`)
	].join('\n');
	writeFileSync(join(OUT_DIR, 'samples.csv'), csv + '\n');

	const yearDist = {};
	for (const i of pickedF) {
		const y = daysF[i].date.slice(0, 4);
		yearDist[y] = (yearDist[y] ?? 0) + 1;
	}
	const report = {
		实验: 'Top5 做T方案稳定性·全历史版：iFinD 前复权日线（2019-12-20上市~今），起点按建仓年份分层抽样×持有1年',
		数据源: 'iFinD ifind_get_price 前复权日线（2026-10-22拉取，3段各≤3年拼接，backtest/_data/515180_daily_all.csv 1654条）；周K由日K按自然周聚合，与腾讯qfqweek口径一致',
		原实验局限: '腾讯接口640条日K上限 → 原样本仅2024-10-28~2025-09-30共230个有效起点，全部落在两年同一行情段内',
		复现校验: {
			说明: '仅取2024-09-01起数据、同种子20261020不放回抽100起点，验证换数据源后与原实验（腾讯qfq）结果一致',
			起点范围: `${daysR[validR[0]].date} ~ ${daysR[validR.at(-1)].date}（有效 ${validR.length} 个，抽样 ${pickedR.length} 个）`,
			summary: repro.summary
		},
		全历史: {
			建模起点: '2019-12-20（上市日，权重模型随时间扩张样本）',
			起点范围: `${daysF[validF[0]].date} ~ ${daysF[validF.at(-1)].date}（有效 ${validF.length} 个）`,
			分层抽样: `按建仓年份比例分配 N=${pickedF.length}（种子${SEED_FULL}），年度分布: ${JSON.stringify(yearDist)}`,
			summary: full.summary
		},
		稳定性结论: '按 均值/标准差 排序（越高越稳），结合 P(亏损) 与分位区间判断；与复现校验/原实验结论对照见 backtest/README.md'
	};
	writeFileSync(join(OUT_DIR, 'report.json'), JSON.stringify(report, null, 2) + '\n');

	console.log('=== 复现校验（2024-09 起，同种子 N=100，应与 20261020-stability 一致）===');
	console.log(`起点范围: ${daysR[validR[0]].date} ~ ${daysR[validR.at(-1)].date}（有效 ${validR.length}，抽样 ${pickedR.length}）`);
	console.table(repro.summary);
	console.log('\n=== 全历史（2019-12-20 上市起，分层抽样 N=' + pickedF.length + '）===');
	console.log(`起点范围: ${daysF[validF[0]].date} ~ ${daysF[validF.at(-1)].date}（有效 ${validF.length}）`);
	console.log(`年度分布: ${JSON.stringify(yearDist)}`);
	console.table(full.summary);
	console.log(`\n输出: ${OUT_DIR}/{samples.csv, report.json}`);
}

try {
	main();
} catch (e) {
	console.error(e);
	process.exit(1);
}
