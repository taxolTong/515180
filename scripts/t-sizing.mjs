/**
 * 做T手法对比回测：有限外部注资（循环额度，不超额）+ 区间内真实复利
 *
 * 测试区间选取（公平性）：
 * 从上一轮 rolling-1y 实验（backtest/20261020-rolling-1y/weighted.csv）中
 * 取年化收益最接近中位数的样本，用其 start~end（约 250 个交易日 ≈ 1 年）作为本轮区间，
 * 即一段"最终收益最普通"的典型行情，不挑好也不挑差。
 * 可用参数覆盖：node scripts/t-sizing.mjs [输出目录] [起始日期] [结束日期]
 *
 * 控制变量（与 20261019 严格回测一致）：
 * - 近期加权模型、相同信号触发时机/阈值（normalT / zoneT、低估加仓、高估减仓、正常区双边做T）
 * - 费用：佣金万二、最低5元，无印花税、无滑点
 * - 初始本金：10000股底仓 + 10000元现金
 *
 * 外部注资规则（防仓位失控）：
 * - 每个策略有循环额度 CAP（3万 / 5万 两档）：现金可为负，但最低不低于 -CAP；
 *   卖出回款自动还贷，额度循环使用、任时刻占用不超过 CAP。
 * - 仓位上限被额度物理锁死（如 5万额度 ≈ 最多 4~5 倍底仓），杜绝"开头加100万股"式刷收益。
 *
 * 唯一变量 = 每笔做T/加减仓的数量：
 * - shares：固定股数（10000=原方案参照 / 5000 / 2000）
 * - pct：原仓位百分比（50% / 25% / 10%，取整百股）
 * - amount：固定金额（1万 / 5000 元，按触发价折股）
 * 清仓等待规则（原方案参照外）：卖出信号时持仓不足一个单位 → 全部清仓；
 * 空仓后不做T，只在低估/极端低估区买入信号重新建仓。
 *
 * 收益率 = 期末净资产/期初本金 - 1（注资为债务而非权益，无外部权益流入）。
 * 附最大额度占用、最大/平均仓位倍数、空仓天数做风控参考。
 *
 * 用法: node scripts/t-sizing.mjs [输出目录，默认 backtest/20261020-t-sizing/] [起始日期] [结束日期]
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
const BASE_SHARES = 10000; // 初始底仓
const INIT_CASH = 10000; // 初始现金（本金一部分）
const CAPS = [30000, 50000]; // 外部注资循环额度（两档对比）

const OUT_DIR = process.argv[2] ? resolve(ROOT, process.argv[2]) : join(ROOT, 'backtest', '20261020-t-sizing');

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const fee = (amount) => Math.max(COMMISSION_MIN, amount * COMMISSION_RATE);
const lot = (x) => Math.max(100, Math.floor(x / 100) * 100); // 折股取整百（至少100股）

/** 从上一轮 rolling 实验取年化最接近中位数的样本作为本轮 1 年测试区间 */
function pickWindow() {
	const rows = readFileSync(join(ROOT, 'backtest/20261020-rolling-1y/weighted.csv'), 'utf8')
		.trim()
		.split('\n')
		.slice(1)
		.map((l) => {
			const [start, end, , ann] = l.split(',');
			return { start, end, ann: parseFloat(ann) };
		});
	const anns = rows.map((r) => r.ann).sort((a, b) => a - b);
	const median = anns[Math.floor(anns.length / 2)];
	const best = rows.reduce((a, b) => (Math.abs(b.ann - median) < Math.abs(a.ann - median) ? b : a));
	return { ...best, median };
}

// —— 待测策略（唯一差别：qtyOf 每笔数量；额度 CAP 为另一维度）——
const BASE_STRATS = [
	{ name: 'shares_固定1万股(原方案)', type: 'shares', unit: 10000, clearWait: false },
	{ name: 'shares_固定5000股', type: 'shares', unit: 5000, clearWait: true },
	{ name: 'shares_固定2000股', type: 'shares', unit: 2000, clearWait: true },
	{ name: 'pct_仓位50%', type: 'pct', pct: 0.5, clearWait: true },
	{ name: 'pct_仓位25%', type: 'pct', pct: 0.25, clearWait: true },
	{ name: 'pct_仓位10%', type: 'pct', pct: 0.1, clearWait: true },
	{ name: 'amount_固定1万元', type: 'amount', amount: 10000, clearWait: true },
	{ name: 'amount_固定5000元', type: 'amount', amount: 5000, clearWait: true }
];

/** 每笔数量：pct 按当前持仓比例（空仓时按底仓1万股计），amount 按触发价折股 */
function qtyOf(s, shares, price) {
	if (s.type === 'shares') return s.unit;
	if (s.type === 'pct') return lot((shares > 0 ? shares : BASE_SHARES) * s.pct);
	if (s.type === 'amount') return lot(s.amount / price);
	return 0;
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
	const win = pickWindow();
	const BT_START = process.argv[3] ?? win.start;
	const BT_END = process.argv[4] ?? win.end;

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

	const allDays = drows.map((r) => ({
		date: r[0],
		open: parseFloat(r[1]),
		close: parseFloat(r[2]),
		high: parseFloat(r[3]),
		low: parseFloat(r[4])
	}));
	const days = allDays.filter((d) => d.date >= BT_START && d.date <= BT_END);
	const amps = allDays
		.filter((d) => d.date < BT_START)
		.map((d) => (d.open > 0 ? (d.high - d.low) / d.open : 0))
		.filter((a) => a > 0);

	// —— 逐日预计算信号（与 backtest.mjs 同一天内判定顺序一致，仅近期加权模型）——
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

	// —— 逐策略模拟：额度 CAP 内循环注资，净资产真实复利 ——
	const startEq0 = INIT_CASH + BASE_SHARES * days[0].close; // 共同起点本金
	const run = (s, cap) => {
		let cash = INIT_CASH;
		let shares = BASE_SHARES;
		let tCount = 0;
		let tWin = 0;
		let tNet = 0;
		let fees = 0;
		let maxBorrow = 0;
		let maxPos = BASE_SHARES * days[0].close;
		let posSum = 0;
		let flatDays = 0;
		const trades = [];
		const equity = [];
		const buy = (date, price, q, note) => {
			const f = fee(price * q);
			cash -= price * q + f;
			shares += q;
			fees += f;
			trades.push({ date, action: '买入', price: +price.toFixed(4), shares: q, note });
		};
		const sell = (date, price, q, note) => {
			const f = fee(price * q);
			cash += price * q - f;
			shares -= q;
			fees += f;
			trades.push({ date, action: '卖出', price: +price.toFixed(4), shares: q, note });
		};
		// 注资额度内可承受：成交后现金不低于 -cap（含佣金，佣金也占额度）
		const affordable = (price, q) => cash - price * q - fee(price * q) >= -cap;
		for (let i = 0; i < days.length; i++) {
			const sig = signals[i];
			const d = days[i];
			if (sig) {
				const flat = shares === 0;
				if (sig.zoneBuy != null) {
					// 低估区买入：清仓等待策略靠它重新建仓，原方案参照空仓时同样允许
					const q = qtyOf(s, shares, sig.zoneBuy);
					if (affordable(sig.zoneBuy, q)) {
						buy(d.date, sig.zoneBuy, q, `${sig.zone} 加仓`);
					}
				} else if (sig.zoneSell != null && shares > 0) {
					const q = qtyOf(s, shares, sig.zoneSell);
					if (shares >= q) sell(d.date, sig.zoneSell, q, `${sig.zone} 减仓`);
					else if (s.clearWait) sell(d.date, sig.zoneSell, shares, `${sig.zone} 持仓不足单位→清仓`);
				} else if (!flat || !s.clearWait) {
					if (sig.t1) {
						const q = qtyOf(s, shares, sig.t1.buy);
						if (affordable(sig.t1.buy, q)) {
							buy(d.date, sig.t1.buy, q, '做T买');
							sell(d.date, sig.t1.sell, q, sig.t1.sell === d.close ? '做T卖 尾盘平回' : '做T卖 对侧阈值');
							const p = (sig.t1.sell - sig.t1.buy) * q;
							const f = fee(sig.t1.buy * q) + fee(sig.t1.sell * q);
							tNet += p - f;
							tCount++;
							if (p - f > 0) tWin++;
						}
					}
					if (sig.t2) {
						const q = qtyOf(s, shares, sig.t2.sell);
						if (shares >= 2 * q && affordable(sig.t2.buy, q)) {
							sell(d.date, sig.t2.sell, q, '反T卖');
							buy(d.date, sig.t2.buy, q, sig.t2.buy === d.close ? '反T买 尾盘回补' : '反T买 对侧阈值');
							const p = (sig.t2.sell - sig.t2.buy) * q;
							const f = fee(sig.t2.sell * q) + fee(sig.t2.buy * q);
							tNet += p - f;
							tCount++;
							if (p - f > 0) tWin++;
						}
					}
				}
			}
			const eq = cash + shares * d.close; // 净资产 = 现金(可为负=占用额度) + 持仓市值
			if (-cash > maxBorrow) maxBorrow = -cash;
			const pos = shares * d.close;
			if (pos > maxPos) maxPos = pos;
			posSum += pos;
			if (shares === 0) flatDays++;
			equity.push(eq);
		}
		const endEq = equity[equity.length - 1];
		return {
			name: `注资${cap / 10000}w_${s.name}`,
			type: s.type,
			cap,
			startEquity: +startEq0.toFixed(2),
			endEquity: +endEq.toFixed(2),
			retPct: +(((endEq - startEq0) / startEq0) * 100).toFixed(2),
			tCount,
			tWinRate: tCount ? ((tWin / tCount) * 100).toFixed(1) + '%' : '-',
			tNet: +tNet.toFixed(2),
			fees: +fees.toFixed(2),
			maxBorrow: +maxBorrow.toFixed(2),
			maxPosMultiple: +(maxPos / startEq0).toFixed(2),
			avgPosMultiple: +(posSum / days.length / startEq0).toFixed(2),
			flatDays,
			endShares: shares,
			trades,
			equity
		};
	};

	const results = [
		// 纯持有参照（不做T，额度无关，只列一次）
		(() => {
			const eqs = days.map((d) => INIT_CASH + BASE_SHARES * d.close);
			const endEq = eqs[eqs.length - 1];
			return {
				name: 'hold_纯持有1万股(参照)',
				type: 'hold',
				cap: 0,
				startEquity: +startEq0.toFixed(2),
				endEquity: +endEq.toFixed(2),
				retPct: +(((endEq - startEq0) / startEq0) * 100).toFixed(2),
				tCount: 0,
				tWinRate: '-',
				tNet: 0,
				fees: 0,
				maxBorrow: 0,
				maxPosMultiple: +(Math.max(...eqs) / startEq0).toFixed(2),
				avgPosMultiple: +(eqs.reduce((a, b) => a + b, 0) / days.length / startEq0).toFixed(2),
				flatDays: 0,
				endShares: BASE_SHARES,
				trades: [],
				equity: eqs
			};
		})(),
		...CAPS.flatMap((cap) => BASE_STRATS.map((s) => run(s, cap)))
	];

	// —— 输出 ——
	mkdirSync(OUT_DIR, { recursive: true });
	const header =
		'strategy,type,cap,return_pct,total_pnl,t_count,t_win_rate,t_net,t_fees,max_borrow,max_pos_x,avg_pos_x,flat_days,end_shares,start_equity,end_equity';
	const csvS = [
		header,
		...results.map(
			(r) =>
				`${r.name},${r.type},${r.cap},${r.retPct},${(r.endEquity - r.startEquity).toFixed(2)},${r.tCount},${r.tWinRate},${r.tNet},${r.fees},${r.maxBorrow},${r.maxPosMultiple},${r.avgPosMultiple},${r.flatDays},${r.endShares},${r.startEquity},${r.endEquity}`
		)
	].join('\n');
	writeFileSync(join(OUT_DIR, 'strategies.csv'), csvS + '\n');

	const csvE = [
		`date,close,${results.map((r) => r.name).join(',')}`,
		...days.map((d, i) => `${d.date},${d.close},${results.map((r) => r.equity[i].toFixed(2)).join(',')}`)
	].join('\n');
	writeFileSync(join(OUT_DIR, 'equity.csv'), csvE + '\n');

	const csvT = [
		'strategy,date,action,price,shares,note',
		...results.flatMap((r) =>
			r.trades.map((tr) => `${r.name},${tr.date},${tr.action},${tr.price},${tr.shares},${tr.note}`)
		)
	].join('\n');
	writeFileSync(join(OUT_DIR, 'trades.csv'), csvT + '\n');

	const tradable = results.filter((r) => r.type !== 'hold');
	const best = tradable.reduce((a, b) => (b.retPct > a.retPct ? b : a));
	const report = {
		实验: '做T手法对比（有限外部注资：循环额度3w/5w + 区间内真实复利）',
		区间选取: `rolling-1y 加权年化中位数 ${win.median}%，取最接近样本 ${win.start} ~ ${win.end}（年化 ${win.ann}%），约1年典型行情`,
		区间: `${days[0].date} ~ ${days[days.length - 1].date} (${days.length} 个交易日)`,
		初始本金: `${BASE_SHARES}股底仓 + ${INIT_CASH}元现金 = ${startEq0.toFixed(2)} 元`,
		注资规则: `循环额度 CAP=${CAPS.map((c) => c / 10000).join('/')}w：现金最低不低于 -CAP，回款自动还贷，任时刻占用不超额；仓位上限被额度物理锁死`,
		控制变量: '近期加权模型、信号时机/阈值/费用与 20261019 严格回测一致，仅每笔数量与额度不同',
		收益率口径: '期末净资产/期初本金 - 1（注资为债务非权益，无外部权益流入）',
		最优方案: {
			name: best.name,
			returnPct: best.retPct,
			tCount: best.tCount,
			tWinRate: best.tWinRate,
			tNet: best.tNet,
			maxBorrow: best.maxBorrow,
			maxPosMultiple: best.maxPosMultiple
		},
		strategies: results.map(({ trades, equity, ...rest }) => rest)
	};
	writeFileSync(join(OUT_DIR, 'report.json'), JSON.stringify(report, null, 2) + '\n');

	console.log(`区间选取: rolling-1y 年化中位数 ${win.median}% → 样本 ${win.start} ~ ${win.end}（年化 ${win.ann}%）`);
	console.log(`回测区间: ${days[0].date} ~ ${days[days.length - 1].date} (${days.length} 个交易日)`);
	console.log(`初始本金: ${startEq0.toFixed(2)} 元（1万股底仓 + 1万现金，循环注资额度 ${CAPS.map((c) => c / 10000).join('/')}w）\n`);
	console.table(
		results.map((r) => ({
			策略: r.name,
			收益率: r.retPct + '%',
			做T净收益: r.tNet,
			做T次数: r.tCount,
			胜率: r.tWinRate,
			费用: r.fees,
			最大注资占用: r.maxBorrow,
			最大仓位x: r.maxPosMultiple,
			空仓天数: r.flatDays,
			期末股数: r.endShares
		}))
	);
	console.log(`\n最优方案: ${best.name}（收益率 ${best.retPct}%）`);
	console.log(`输出: ${OUT_DIR}/{strategies,equity,trades}.csv, report.json`);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
