/**
 * 通用交易模型实验引擎（模型A宽通道高门槛 / 模型B参数寻优 共用）
 *
 * 与 scripts/stability-full.mjs 同源的账户模拟，但参数化：
 *   - 通道分位数 zoneP / extremeP（基线 0.05 / 0.01，可调宽）
 *   - T 阈值系数 tK、上下限 tMin/tMax、振幅统计分位 ampQ、窗口 ampWindow
 *   - 高/低估区触发系数 zoneRatio 及上下限
 *   - zoneCooldown：同向区交易最小间隔天数（防宽通道下连续每日触发）
 *   - tExit: 'sameDay'（基线：尾盘强制平回）| 'hold'（允许过夜：
 *     目标价=入场×(1±T×holdTargetK)、止损=×(1∓T×holdStopK)、holdMaxDays 后强制收盘了结）
 *
 * 共用约束：BASE_SHARES=10000 底仓、INIT_CASH=10000、CAP=50000 循环额度（现金下限-CAP）、
 * 佣金万二最低5元、**每笔操作固定金额 1 万元**（股数=1万÷成交价按100股取整，屏蔽前复权
 * 对固定股数操作价格的失真）、信号用 t 日前已完成周K拟合（无未来函数）、
 * 成交假设与基线一致：限价单触及即按触发价成交；过夜单止盈/止损同日都触及时按止损先成交（保守）。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export const COMMISSION_RATE = 0.0002;
export const COMMISSION_MIN = 5;
export const BASE_SHARES = 10000;
export const INIT_CASH = 10000;
export const CAP = 50000; // 5w 活动资金，可循环，不可超额
export const UNIT = 10000; // 每单位股数
export const HOLD_DAYS = 250;
export const DATA_FILE = join(ROOT, 'backtest', '_data', '515180_daily_all.csv');

export const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
export const fee = (amount) => Math.max(COMMISSION_MIN, amount * COMMISSION_RATE);
const lot = (x) => Math.max(100, Math.floor(x / 100) * 100);

/** 基线配置（与 stability-full.mjs 逐参数一致） */
export const BASELINE = {
	name: 'baseline_原方案(5%/95%,T×0.45)',
	zoneP: 0.05,
	extremeP: 0.01,
	halfLife: 26,
	ampWindow: 20,
	ampQ: 0.5,
	tK: 0.45,
	tMin: 0.005,
	tMax: 0.01,
	zoneRatio: 0.8,
	zoneTMin: 0.004,
	zoneTMax: 0.008,
	zoneCooldown: 0,
	tExit: 'sameDay',
	holdTargetK: 1.0,
	holdStopK: 0.5,
	holdMaxDays: 5
};

/** 读 iFinD 全历史前复权日线 → { days, allWeeks }（口径与 stability-full 一致） */
export function loadData(startDate) {
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
	const byWeek = new Map();
	for (const d of days) {
		const dt = new Date(d.date + 'T00:00:00Z');
		const day = (dt.getUTCDay() + 6) % 7;
		const monday = new Date(dt.getTime() - day * 86400000);
		const key = monday.toISOString().slice(0, 10);
		if (!byWeek.has(key)) byWeek.set(key, { date: d.date, price: d.close });
		const w = byWeek.get(key);
		w.date = d.date;
		w.price = d.close;
	}
	const allWeeks = [...byWeek.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
	return { days, allWeeks };
}

/** 纯函数版加权分位数：预计算累积权重，任意顺序/重复调用结果一致 */
function weightedQuantileFn(values, weights) {
	const order = values.map((v, i) => [v, weights[i]]).sort((a, b) => a[0] - b[0]);
	const cum = new Array(order.length);
	let acc = 0;
	for (let i = 0; i < order.length; i++) {
		acc += order[i][1];
		cum[i] = acc;
	}
	const total = acc;
	return (p) => {
		let lo = 0;
		let hi = order.length - 1;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			if (cum[mid] / total >= p) hi = mid;
			else lo = mid + 1;
		}
		return order[lo][0];
	};
}

/** 预计算每个交易日的趋势模型（残差加权分位数函数），供所有配置复用 */
export function buildDayModels(days, allWeeks, halfLife = 26) {
	const baseDate = allWeeks[0].date;
	const dayNum = (a, b) =>
		Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000);
	for (const w of allWeeks) w.t = dayNum(baseDate, w.date);
	const xs = allWeeks.map((w) => w.t);
	const ys = allWeeks.map((w) => w.price);
	const n = xs.length;

	const models = new Array(days.length).fill(null);
	const ampHist = new Array(days.length).fill(null); // ampHist[i] = 日之前全部正振幅
	let amps = [];
	for (let i = 0; i < days.length; i++) {
		const d = days[i];
		ampHist[i] = amps; // 引用快照（amps 之后 push 不影响此引用）
		const weeks = allWeeks.filter((w) => w.date < d.date);
		if (weeks.length >= 8 && amps.length >= 20) {
			const wxs = weeks.map((w) => w.t);
			const wys = weeks.map((w) => w.price);
			const wn = wxs.length;
			const ws = wxs.map((x) => 0.5 ** ((wxs[wn - 1] - x) / 7 / halfLife));
			const W = ws.reduce((a, b) => a + b, 0);
			const mx = ws.reduce((a, w, j) => a + w * wxs[j], 0) / W;
			const my = ws.reduce((a, w, j) => a + w * wys[j], 0) / W;
			let num = 0;
			let den = 0;
			for (let j = 0; j < wn; j++) {
				num += ws[j] * (wxs[j] - mx) * (wys[j] - my);
				den += ws[j] * (wxs[j] - mx) ** 2;
			}
			const slope = den === 0 ? 0 : num / den;
			const intercept = my - slope * mx;
			const res = wys.map((y, j) => y - (intercept + slope * wxs[j]));
			const t = dayNum(baseDate, d.date);
			models[i] = {
				trend: intercept + slope * t,
				resQ: weightedQuantileFn(res, ws)
			};
		}
		const amp = d.open > 0 ? (d.high - d.low) / d.open : 0;
		if (amp > 0) amps.push(amp);
	}
	return { models, ampHist };
}

/**
 * 按配置取某日信号。与基线语义一致：
 * 低/极端低估区：日内跌 ≥ zoneT → 限价买入持有；高/极端高估区对称；
 * 正常区：双边做T（t1 先买后卖、t2 先卖后买，可同日都触发）；
 * tExit='hold' 时，未达对侧阈值的腿不过夜强平，转为持仓单（在 run 中管理）。
 */
export function daySignal(cfg, m, d, ampHist) {
	const zoneP = cfg.zoneP;
	const lowLine = m.resQ(cfg.extremeP); // 极端低估
	const low05 = m.resQ(zoneP);
	const high95 = m.resQ(1 - zoneP);
	const high99 = m.resQ(1 - cfg.extremeP);
	let zone = 'normal';
	if (d.open < m.trend + lowLine) zone = 'extreme_low';
	else if (d.open < m.trend + low05) zone = 'low';
	else if (d.open > m.trend + high99) zone = 'extreme_high';
	else if (d.open > m.trend + high95) zone = 'high';

	// 动态T阈值：之前 ampWindow 个交易日振幅的 ampQ 分位数（基线：20日×0.5=中位数）
	const window = cfg.ampWindow ?? 20;
	const p = cfg.ampQ ?? 0.5;
	const hist = ampHist ?? [];
	const sorted = hist.slice(-window).sort((a, b) => a - b);
	const pos = (sorted.length - 1) * p;
	const b0 = Math.floor(pos);
	const amp =
		sorted.length > 0
			? sorted[b0] + (pos - b0) * ((sorted[b0 + 1] ?? sorted[b0]) - sorted[b0])
			: 0.01;
	const normalT = clamp(amp * cfg.tK, cfg.tMin, cfg.tMax);
	const zoneT = clamp(normalT * cfg.zoneRatio, cfg.zoneTMin, cfg.zoneTMax);
	const s = { zone, normalT, zoneT };
	const buyTrig = d.open * (1 - normalT);
	const sellTrig = d.open * (1 + normalT);
	if (zone === 'low' || zone === 'extreme_low') {
		s.zoneBuy = d.low <= d.open * (1 - zoneT) ? d.open * (1 - zoneT) : null;
	} else if (zone === 'high' || zone === 'extreme_high') {
		s.zoneSell = d.high >= d.open * (1 + zoneT) ? d.open * (1 + zoneT) : null;
	} else {
		s.t1 = d.low <= buyTrig ? { buy: buyTrig, sell: d.high >= sellTrig ? sellTrig : null } : null;
		s.t2 = d.high >= sellTrig ? { sell: sellTrig, buy: d.low <= buyTrig ? buyTrig : null } : null;
	}
	return s;
}

/**
 * 单起点 × 单配置模拟。**每笔操作固定金额**（默认 1 万元，cfg.amount 可覆盖）：
 * 股数 = lot(金额÷成交价)（100 股整数倍，最低 100 股），T 单与区交易同口径；
 * 过夜持仓单记录每笔实际股数。
 * hold 模式持仓单：buy 单目标=buy×(1+T×holdTargetK)、止损=buy×(1−T×holdStopK)；
 * sell 单（反T）对称；同日止盈止损都触及时按止损成交（保守）；holdMaxDays 后按收盘强制了结。
 * 返回 { cash, shares, endIdx, tStats }
 */
export function run(cfg, startIdx, days, models, endOverride = null, ampHist = null) {
	let cash = INIT_CASH;
	let shares = BASE_SHARES;
	const endIdx = Math.min(startIdx + HOLD_DAYS, endOverride ?? days.length) - 1;
	const AMOUNT = cfg.amount ?? 10000; // 每笔固定金额（元）
	const qtyOf = (price) => lot(AMOUNT / price);
	const affordable = (price, q) => cash - price * q - fee(price * q) >= -CAP;

	let openBuys = []; // {px, day, target, stop, qty}
	let openSells = []; // {px, day, target, stop, qty}
	let lastZoneBuyDay = -1e9;
	let lastZoneSellDay = -1e9;
	let tProfit = 0;
	let tWin = 0;
	let tCount = 0;
	let tFailClose = 0; // 尾盘不利价平回次数（sameDay 模式下 close<buy 或 close>sell）
	let zoneBuyCount = 0;
	let zoneSellCount = 0;

	const closeT = (px, exitPx, q) => {
		const p = (exitPx - px) * q;
		const f = fee(px * q) + fee(exitPx * q);
		tProfit += p - f;
		tCount++;
		if (p - f > 0) tWin++;
	};

	for (let i = startIdx; i <= endIdx; i++) {
		const d = days[i];
		const m = models[i];
		if (!m) continue;
		const sig = daySignal(cfg, m, d, ampHist ? ampHist[i] : null);

		// 1) 过夜单了结（先释放资金/份额）
		const T = sig.normalT;
		openBuys = openBuys.filter((p) => {
			let exit = null;
			if (d.low <= p.stop) exit = p.stop; // 保守：止损优先
			else if (d.high >= p.target) exit = p.target;
			else if (i - p.day >= cfg.holdMaxDays) exit = d.close;
			if (exit == null) return true;
			cash += exit * p.qty - fee(exit * p.qty);
			shares -= p.qty;
			closeT(p.px, exit, p.qty);
			if (exit === d.close) tFailClose++;
			return false;
		});
		openSells = openSells.filter((p) => {
			let exit = null;
			if (d.high >= p.stop) exit = p.stop;
			else if (d.low <= p.target) exit = p.target;
			else if (i - p.day >= cfg.holdMaxDays) exit = d.close;
			if (exit == null) return true;
			cash -= exit * p.qty + fee(exit * p.qty);
			shares += p.qty;
			closeT(p.px, exit, p.qty);
			if (exit === d.close) tFailClose++;
			return false;
		});

		const openSellUnits = openSells.reduce((a, p) => a + p.qty, 0);

		// 2) 区交易（低/高估区加减仓，带冷却）
		if (sig.zoneBuy != null && i - lastZoneBuyDay >= cfg.zoneCooldown) {
			const q = qtyOf(sig.zoneBuy);
			if (affordable(sig.zoneBuy, q)) {
				cash -= sig.zoneBuy * q + fee(sig.zoneBuy * q);
				shares += q;
				lastZoneBuyDay = i;
				zoneBuyCount++;
			}
		} else if (sig.zoneSell != null && i - lastZoneSellDay >= cfg.zoneCooldown) {
			const q = Math.min(qtyOf(sig.zoneSell), shares - openSellUnits);
			if (q >= 100) {
				cash += sig.zoneSell * q - fee(sig.zoneSell * q);
				shares -= q;
				lastZoneSellDay = i;
				zoneSellCount++;
			}
		}

		// 3) 正常区做T（cfg.noT 仅用于收益分解诊断：禁止新开T单）
		if (!cfg.noT && sig.t1) {
			const q = qtyOf(sig.t1.buy);
			if (affordable(sig.t1.buy, q)) {
				cash -= sig.t1.buy * q + fee(sig.t1.buy * q);
				shares += q;
				if (sig.t1.sell != null) {
					cash += sig.t1.sell * q - fee(sig.t1.sell * q);
					shares -= q;
					closeT(sig.t1.buy, sig.t1.sell, q);
				} else if (cfg.tExit === 'sameDay') {
					cash += d.close * q - fee(d.close * q);
					shares -= q;
					closeT(sig.t1.buy, d.close, q);
					tFailClose++;
				} else {
					openBuys.push({
						px: sig.t1.buy,
						day: i,
						qty: q,
						target: sig.t1.buy * (1 + T * cfg.holdTargetK),
						stop: sig.t1.buy * (1 - T * cfg.holdStopK)
					});
				}
			}
		}
		if (!cfg.noT && sig.t2) {
			const q = qtyOf(sig.t2.sell);
			if (shares - openSellUnits >= BASE_SHARES + q) {
				cash += sig.t2.sell * q - fee(sig.t2.sell * q);
				shares -= q;
				if (sig.t2.buy != null) {
					cash -= sig.t2.buy * q + fee(sig.t2.buy * q);
					shares += q;
					closeT(sig.t2.sell, sig.t2.buy, q);
				} else if (cfg.tExit === 'sameDay') {
					cash -= d.close * q + fee(d.close * q);
					shares += q;
					closeT(sig.t2.sell, d.close, q);
					tFailClose++;
				} else {
					openSells.push({
						px: sig.t2.sell,
						day: i,
						qty: q,
						target: sig.t2.sell * (1 - T * cfg.holdTargetK),
						stop: sig.t2.sell * (1 + T * cfg.holdStopK)
					});
				}
			}
		}
	}

	// 期末仍持有的过夜单按最后收盘强制了结（计一次 T 结果）
	for (const p of openBuys) {
		const c = days[endIdx].close;
		cash += c * p.qty - fee(c * p.qty);
		shares -= p.qty;
		closeT(p.px, c, p.qty);
	}
	for (const p of openSells) {
		const c = days[endIdx].close;
		cash -= c * p.qty + fee(c * p.qty);
		shares += p.qty;
		closeT(p.px, c, p.qty);
	}

	return {
		cash,
		shares,
		endIdx,
		tStats: {
			tCount,
			tWinRate: tCount ? tWin / tCount : 0,
			tProfit,
			tFailClose,
			zoneBuyCount,
			zoneSellCount
		}
	};
}

export const dayNumBetween = (a, b) =>
	Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000);

/** mulberry32 固定种子伪随机（与 stability-full 同实现） */
export function rng(seed) {
	let a = seed >>> 0;
	return () => {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** 按建仓年份分层抽样（同 stability-full） */
export function sampleStratified(validStarts, days, n, seed) {
	const byYear = new Map();
	for (const i of validStarts) {
		const y = days[i].date.slice(0, 4);
		if (!byYear.has(y)) byYear.set(y, []);
		byYear.get(y).push(i);
	}
	const rand = rng(seed);
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

export function summarizeAnns(anns) {
	const n = anns.length;
	const mean = anns.reduce((a, b) => a + b, 0) / n;
	const std = Math.sqrt(anns.reduce((a, b) => a + (b - mean) ** 2, 0) / n);
	const s = [...anns].sort((a, b) => a - b);
	const pct = (p) => s[Math.min(n - 1, Math.floor(p * n))];
	return {
		n,
		mean,
		std,
		sharpe: std > 0 ? mean / std : 0,
		median: pct(0.5),
		worst: s[0],
		p10: pct(0.1),
		p90: pct(0.9),
		best: s[n - 1],
		pLoss: s.filter((a) => a < 0).length / n,
		p10pct: s.filter((a) => a > 10).length / n,
		p20pct: s.filter((a) => a > 20).length / n
	};
}
