/**
 * 20261028-signal-close：多过夜T + 昨收触发 + 0轴日内平回（signal-close 唯一有效版本）
 *
 * 规则沿革（按用户 2026-10-28 修正）：
 *  - 允许多个过夜 T 单同时持有：每单独立计算自己的 5 天期限与（B092 的）止盈止损，
 *    最多 5 笔（5 万循环额度 ÷ 每笔 1 万），单边下跌可连续 5 天用完 5 次加仓。
 *  - 第 5 日强平抵消规则：某腿满 5 日需尾盘强平，若当日有同向新触发，则抵消——
 *    不强平也不开新仓，继续持有（第七日第八日还跌就继续持有）；无同向触发才强平。
 *  - 触发基准改为昨收：当日 high >= 昨收×(1+T) 触发卖出，low <= 昨收×(1−T) 触发买入，
 *    成交价即触发价（昨收±T）。
 *  - 日内平回判定改为回到 0 轴：今收 vs 昨收。做多腿当日 close >= 昨收、做空腿
 *    当日 close <= 昨收，即认为回到 0 轴，按今收平回。日线数据下精确可判定。
 *  - signal 平回：反向触发价平掉所有反向旧仓（V1 语义），无相对买入价的止盈止损；
 *    B092：每腿按自身买入价的 +1.4T / −0.5T 止盈止损；control：尾盘必平。
 *  - 允许卖穿底仓但禁止负库存；同向卖出需净库存足够一笔。
 *
 * 用法: node scripts/model-signal-close.mjs [样本数N，默认1000] [种子，逗号分隔]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	BASE_SHARES, CAP, HOLD_DAYS, loadData, buildDayModels, daySignal,
	fee, rng
} from './model-lib.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'backtest', '20261028-signal-close');
const N = parseInt(process.argv[2] ?? '1000', 10);
const SEEDS = (process.argv[3] ?? '20261028,20261029').split(',').map(Number);
const INIT_CASH = 0;
const AMOUNT = 10000;
const MAX_LEGS = Math.floor(CAP / AMOUNT); // 5 笔

const PARAMS = {
	zoneP: 0.23, extremeP: 0.02, tK: 0.58, tMin: 0.004, tMax: 0.015,
	ampWindow: 60, ampQ: 0.33,
	zoneRatio: 0.63, zoneTMin: 0.004, zoneTMax: 0.012,
	zoneCooldown: 0
};
const CONFIGS = [
	{ name: 'S-signal(信号平回,多腿)', ...PARAMS, tExit: 'signal', holdMaxDays: 5 },
	{ name: 'B092(价格平回,多腿)', ...PARAMS, tExit: 'hold', holdTargetK: 1.4, holdStopK: 0.5, holdMaxDays: 5 },
	{ name: 'control(尾盘必平)', ...PARAMS, tExit: 'sameDay', holdMaxDays: 5 }
];

const lot = (x) => Math.max(100, Math.floor(x / 100) * 100);
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const median = (xs) => {
	if (!xs.length) return 0;
	const s = [...xs].sort((a, b) => a - b);
	const m = Math.floor(s.length / 2);
	return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const round = (x, n = 2) => +x.toFixed(n);

function logChoose(n, k) {
	let x = 0;
	for (let i = 1; i <= k; i++) x += Math.log((n - k + i) / i);
	return x;
}

/** 二项符号检验：H0=胜负各 50%，双侧 p 值 */
function signTestP(wins, losses) {
	const n = wins + losses;
	if (!n) return null;
	const k = Math.min(wins, losses);
	let tail = 0;
	for (let x = 0; x <= k; x++) tail += Math.exp(logChoose(n, x) - n * Math.log(2));
	return round(Math.min(1, 2 * tail), 6);
}

function sampleUniform(valid, n, seed) {
	const rand = rng(seed);
	const arr = [...valid];
	for (let i = arr.length - 1; i > 0; i--) {
		const j = Math.floor(rand() * (i + 1));
		[arr[i], arr[j]] = [arr[j], arr[i]];
	}
	return arr.slice(0, Math.min(n, arr.length)).sort((a, b) => a - b);
}

/**
 * 单起点模拟。多腿并存，每腿独立 5 日期限。
 * “short”是卖出实际持仓形成的待买回义务；净库存不允许为负。
 */
function runSim(cfg, startIdx, days, models, ampHist) {
	let cash = INIT_CASH;
	let shares = BASE_SHARES;
	const endIdx = Math.min(startIdx + HOLD_DAYS, days.length) - 1;
	const qtyOf = (price) => lot(AMOUNT / price);
	let openLegs = [];
	let lastZoneBuyDay = -1e9;
	let lastZoneSellDay = -1e9;
	let tProfit = 0;
	let tWin = 0;
	let tCount = 0;
	let tHoldDays = 0;
	let tMaxLoss = 0;
	let zoneBuyCount = 0;
	let zoneSellCount = 0;
	const tExitCounts = { zeroAxis: 0, signal: 0, target: 0, stop: 0, force: 0, offset: 0, tail: 0, end: 0 };
	const trades = [];

	const closePosition = (p, exitPx, exitDay, reason) => {
		if (p.side === 'long') {
			cash += exitPx * p.qty - fee(exitPx * p.qty);
			shares -= p.qty;
		} else {
			cash -= exitPx * p.qty + fee(exitPx * p.qty);
			shares += p.qty;
		}
		const sideSign = p.side === 'long' ? 1 : -1;
		const gross = (exitPx - p.px) * p.qty * sideSign;
		const f = fee(p.px * p.qty) + fee(exitPx * p.qty);
		const net = gross - f;
		const holdDays = exitDay - p.day + 1;
		tProfit += net;
		tCount++;
		if (net > 0) tWin++;
		tHoldDays += holdDays;
		if (net < tMaxLoss) tMaxLoss = net;
		tExitCounts[reason]++;
		trades.push({
			side: p.side,
			qty: p.qty,
			entryDate: days[p.day].date,
			exitDate: days[exitDay].date,
			entryPx: p.px,
			exitPx,
			gross: round(gross),
			net: round(net),
			holdDays,
			exitReason: reason
		});
	};

	for (let i = startIdx; i <= endIdx; i++) {
		const d = days[i];
		const m = models[i];
		if (!m) continue;
		const sig = daySignal(cfg, m, d, ampHist ? ampHist[i] : null);
		const T = sig.normalT;
		const ref = days[i - 1].close; // 昨收 = 0 轴
		const buyTrig = ref * (1 - T);
		const sellTrig = ref * (1 + T);
		const buyHit = d.low <= buyTrig;
		const sellHit = d.high >= sellTrig;
		const isNormal = sig.zone === 'normal';
		// 抵消标记：当日某方向触发用于延续满 5 日旧仓时，该方向不再开新仓
		const offsetBlocked = { buy: false, sell: false };

		// ---- 1) 旧仓了结（今日之前开的仓） ----
		openLegs = openLegs.filter((p) => {
			if (p.day === i) return true; // 今日新开，见下方 0 轴/尾盘处理
			// signal：反向触发价平掉全部反向旧仓
			if (cfg.tExit === 'signal') {
				if (p.side === 'long' && sellHit) { closePosition(p, sellTrig, i, 'signal'); return false; }
				if (p.side === 'short' && buyHit) { closePosition(p, buyTrig, i, 'signal'); return false; }
			} else if (cfg.tExit === 'hold') {
				// B092：按本腿买入价的 +1.4T 止盈 / −0.5T 止损
				if (p.side === 'long') {
					if (d.low <= p.stop) { closePosition(p, p.stop, i, 'stop'); return false; }
					if (d.high >= p.target) { closePosition(p, p.target, i, 'target'); return false; }
				} else {
					if (d.high >= p.stop) { closePosition(p, p.stop, i, 'stop'); return false; }
					if (d.low <= p.target) { closePosition(p, p.target, i, 'target'); return false; }
				}
			}
			// 满 5 日：强平 or 同向触发抵消续持
			if (i - p.day + 1 >= cfg.holdMaxDays) {
				const sameDirHit = p.side === 'long' ? buyHit : sellHit;
				if (sameDirHit) {
					tExitCounts.offset++;
					offsetBlocked[p.side === 'long' ? 'buy' : 'sell'] = true;
					return true; // 抵消：继续持有
				}
				closePosition(p, d.close, i, 'force');
				return false;
			}
			return true;
		});

		// ---- 2) 区加减仓（与旧实验相同，不属于 T 统计） ----
		const openShortUnits = openLegs.filter((p) => p.side === 'short').reduce((a, p) => a + p.qty, 0);
		if (sig.zoneBuy != null && i - lastZoneBuyDay >= cfg.zoneCooldown) {
			const q = qtyOf(sig.zoneBuy);
			if (cash - sig.zoneBuy * q - fee(sig.zoneBuy * q) >= -CAP) {
				cash -= sig.zoneBuy * q + fee(sig.zoneBuy * q);
				shares += q;
				lastZoneBuyDay = i;
				zoneBuyCount++;
			}
		} else if (sig.zoneSell != null && i - lastZoneSellDay >= cfg.zoneCooldown) {
			const available = shares - openShortUnits;
			const q = Math.min(qtyOf(sig.zoneSell), available);
			if (q >= 100) {
				cash += sig.zoneSell * q - fee(sig.zoneSell * q);
				shares -= q;
				lastZoneSellDay = i;
				zoneSellCount++;
			}
		}

		// ---- 3) 正常区 T：开新腿（多腿并存，最多 5 笔） ----
		const mkLeg = (side, px, q) => ({
			side, px, day: i, qty: q, entryT: T,
			target: side === 'long' ? px * (1 + T * cfg.holdTargetK) : px * (1 - T * cfg.holdTargetK),
			stop: side === 'long' ? px * (1 - T * cfg.holdStopK) : px * (1 + T * cfg.holdStopK)
		});
		const todayLegs = [];
		if (isNormal && openLegs.length < MAX_LEGS) {
			if (buyHit && !offsetBlocked.buy) {
				const px = buyTrig;
				const q = qtyOf(px);
				if (cash - px * q - fee(px * q) >= -CAP) {
					cash -= px * q + fee(px * q);
					shares += q;
					const p = mkLeg('long', px, q);
					openLegs.push(p);
					todayLegs.push(p);
				}
			}
			if (sellHit && !offsetBlocked.sell && openLegs.length < MAX_LEGS) {
				const px = sellTrig;
				const q = qtyOf(px);
				if (shares - openShortUnits >= q) {
					cash += px * q - fee(px * q);
					shares -= q;
					const p = mkLeg('short', px, q);
					openLegs.push(p);
					todayLegs.push(p);
				}
			}
		}

		// ---- 4) 今日新腿：0 轴平回 / control 尾盘必平 ----
		for (const p of todayLegs) {
			const backToZero = p.side === 'long' ? d.close >= ref : d.close <= ref;
			if (cfg.tExit === 'sameDay') {
				closePosition(p, d.close, i, 'tail');
				p.closed = true;
			} else if (backToZero) {
				closePosition(p, d.close, i, 'zeroAxis');
				p.closed = true;
			}
		}
		openLegs = openLegs.filter((p) => !p.closed);
	}

	// 窗口末尾仍未了结的 T 单按最后收盘强制了结
	for (const p of openLegs) closePosition(p, days[endIdx].close, endIdx, 'end');

	return {
		cash,
		shares,
		endIdx,
		tStats: {
			tCount,
			tWinRate: tCount ? tWin / tCount : 0,
			tProfit,
			tHoldDays,
			tMaxLoss,
			tExitCounts,
			trades,
			zoneBuyCount,
			zoneSellCount
		}
	};
}

function summarizeRows(rows, name) {
	const anns = rows.map((r) => r.ann);
	const rets = rows.map((r) => r.ret);
	const totalT = rows.reduce((a, r) => a + r.tCount, 0);
	const totalProfit = rows.reduce((a, r) => a + r.tProfit, 0);
	return {
		策略: name,
		样本数: rows.length,
		年化均值: round(mean(anns)).toFixed(2) + '%',
		年化中位: round(median(anns)).toFixed(2) + '%',
		收益均值: round(mean(rets)).toFixed(2) + '%',
		收益中位: round(median(rets)).toFixed(2) + '%',
		最差年化: round(Math.min(...anns)).toFixed(2) + '%',
		P亏损: (rows.filter((r) => r.ann < 0).length / rows.length * 100).toFixed(1) + '%',
		年均笔数: round(mean(rows.map((r) => r.tCount)), 1),
		胜率: (mean(rows.map((r) => r.tWinRate)) * 100).toFixed(1) + '%',
		单笔期望元: totalT ? (totalProfit / totalT).toFixed(0) : '0',
		最大单笔亏元: Math.min(...rows.map((r) => r.tMaxLoss)).toFixed(0),
		平均持仓天数: totalT ? (totalHold(rows) / totalT).toFixed(1) : '0.0',
		强平笔数均值: round(mean(rows.map((r) => r.tForce)), 1),
		抵消续持均值: round(mean(rows.map((r) => r.tOffset)), 1),
		零轴平回均值: round(mean(rows.map((r) => r.tZeroAxis)), 1),
		T净收益均值元: round(mean(rows.map((r) => r.tProfit))).toFixed(0),
		区买均值: round(mean(rows.map((r) => r.zb)), 1),
		区卖均值: round(mean(rows.map((r) => r.zs)), 1)
	};
}
const totalHold = (rows) => rows.reduce((a, r) => a + r.tHoldDays, 0);

function pairStats(seedRows, aName, bName) {
	const key = (r) => `${r.seed}|${r.start}`;
	const bMap = new Map(seedRows.filter((r) => r.strategy === bName).map((r) => [key(r), r]));
	const diffs = [];
	const retDiffs = [];
	let wins = 0;
	let losses = 0;
	let ties = 0;
	for (const a of seedRows.filter((r) => r.strategy === aName)) {
		const b = bMap.get(key(a));
		if (!b) continue;
		const diff = a.ann - b.ann;
		diffs.push(diff);
		retDiffs.push(a.ret - b.ret);
		if (diff > 0) wins++;
		else if (diff < 0) losses++;
		else ties++;
	}
	const n = diffs.length;
	return {
		比较: `${aName} vs ${bName}`,
		样本数: n,
		[`${aName}胜出的经验p`]: (wins / n).toFixed(3),
		[`${bName}胜出的经验p`]: (losses / n).toFixed(3),
		平局: ties,
		超额年化均值pp: round(mean(diffs)).toFixed(2),
		超额年化中位pp: round(median(diffs)).toFixed(2),
		超额收益均值pp: round(mean(retDiffs)).toFixed(2),
		超额收益中位pp: round(median(retDiffs)).toFixed(2),
		符号检验双侧p: signTestP(wins, losses)
	};
}

function downPeriodStats(rows, strategyName) {
	const ts = rows
		.filter((r) => r.strategy === strategyName)
		.flatMap((r) => r.trades)
		.filter((t) => t.exitDate >= '2022-01-01' && t.exitDate <= '2024-12-31');
	const nets = ts.map((t) => t.net);
	const srt = [...nets].sort((a, b) => a - b);
	const p10 = srt.length ? srt[Math.max(0, Math.floor(srt.length * 0.1))] : 0;
	return {
		策略: strategyName,
		样本笔数: nets.length,
		亏损率: nets.length ? (nets.filter((x) => x < 0).length / nets.length * 100).toFixed(1) + '%' : '0%',
		平均单笔元: round(mean(nets)),
		中位单笔元: round(median(nets)),
		最差单笔元: round(Math.min(...nets)),
		P10单笔元: round(p10)
	};
}

function main() {
	const { days, allWeeks } = loadData('2019-12-20');
	const { models, ampHist } = buildDayModels(days, allWeeks);
	const validStarts = [];
	for (let i = 0; i + HOLD_DAYS < days.length; i++) if (models[i]) validStarts.push(i);
	console.log(`有效随机起点池 ${validStarts.length} 个（${days[validStarts[0]].date} ~ ${days[validStarts.at(-1)].date}）`);
	mkdirSync(OUT_DIR, { recursive: true });

	const rows = [];
	for (const seed of SEEDS) {
		const picked = sampleUniform(validStarts, N, seed);
		console.log(`种子 ${seed}：不放回随机抽样 ${picked.length} 个起点`);
		for (const i of picked) {
			const d0 = days[i];
			// 真实投资口径：底仓市值 + 5 万循环额度；期末总资产 = 现金 + 持仓市值 + 5 万
			const startEq = INIT_CASH + BASE_SHARES * d0.open + CAP;
			for (const cfg of CONFIGS) {
				const r = runSim(cfg, i, days, models, ampHist);
				const e = r.endIdx;
				const endEq = r.cash + r.shares * days[e].close + CAP;
				const calDays = Math.round((new Date(days[e].date) - new Date(d0.date)) / 86400000);
				const ann = ((endEq / startEq) ** (365.25 / calDays) - 1) * 100;
				const sideCount = { long: 0, short: 0 };
				for (const t of r.tStats.trades) sideCount[t.side]++;
				rows.push({
					seed, start: d0.date, end: days[e].date, strategy: cfg.name,
					startEq: round(startEq), endEq: round(endEq),
					ret: round((endEq / startEq - 1) * 100), ann: round(ann),
					tCount: r.tStats.tCount, tWinRate: r.tStats.tWinRate, tProfit: round(r.tStats.tProfit),
					tHoldDays: r.tStats.tHoldDays, tMaxLoss: round(r.tStats.tMaxLoss),
					tForce: r.tStats.tExitCounts.force, tOffset: r.tStats.tExitCounts.offset,
					tZeroAxis: r.tStats.tExitCounts.zeroAxis,
					longTrades: sideCount.long, shortTrades: sideCount.short,
					zb: r.tStats.zoneBuyCount, zs: r.tStats.zoneSellCount,
					trades: r.tStats.trades
				});
			}
		}
	}

	const summary = CONFIGS.map((c) => summarizeRows(rows.filter((r) => r.strategy === c.name), c.name));
	const bySeed = SEEDS.map((seed) => ({
		种子: seed,
		汇总: CONFIGS.map((c) => summarizeRows(rows.filter((r) => r.seed === seed && r.strategy === c.name), c.name)),
		配对: [
			pairStats(rows.filter((r) => r.seed === seed), CONFIGS[0].name, CONFIGS[1].name),
			pairStats(rows.filter((r) => r.seed === seed), CONFIGS[0].name, CONFIGS[2].name),
			pairStats(rows.filter((r) => r.seed === seed), CONFIGS[1].name, CONFIGS[2].name)
		]
	}));
	const combinedPairs = [
		pairStats(rows, CONFIGS[0].name, CONFIGS[1].name),
		pairStats(rows, CONFIGS[0].name, CONFIGS[2].name),
		pairStats(rows, CONFIGS[1].name, CONFIGS[2].name)
	];
	const downPeriod = CONFIGS.map((c) => downPeriodStats(rows, c.name));

	const csv = [
		'seed,start,end,strategy,start_equity,end_equity,return_pct,annualized_pct,t_count,t_winrate_pct,t_profit,t_holddays,t_maxloss,t_force,t_offset,t_zeroaxis,long_trades,short_trades,zone_buys,zone_sells',
		...rows.map((r) =>
			`${r.seed},${r.start},${r.end},"${r.strategy}",${r.startEq},${r.endEq},${r.ret},${r.ann},${r.tCount},${(r.tWinRate * 100).toFixed(1)},${r.tProfit},${r.tHoldDays},${r.tMaxLoss},${r.tForce},${r.tOffset},${r.tZeroAxis},${r.longTrades},${r.shortTrades},${r.zb},${r.zs}`
		)
	].join('\n');
	writeFileSync(join(OUT_DIR, 'samples.csv'), csv + '\n');
	writeFileSync(join(OUT_DIR, 'report.json'), JSON.stringify({
		实验: 'signal-close（昨收触发 + 0轴日内平 + 多过夜腿）：0现金+1万股底仓+5万循环额度；最多5笔并存；第5日强平可被同向触发抵消续持；年化按真实投资口径=底仓市值+5万',
		样本数每种子的策略数: N,
		种子: SEEDS,
		规则假设: [
			'触发基准=昨收：high>=昨收*(1+T) 卖出、low<=昨收*(1-T) 买入，成交价=触发价',
			'日内平回=回到0轴：今收>=昨收平多、今收<=昨收平空，按今收成交',
			'每腿独立计5日（含开仓日）；满5日且有同向触发则抵消续持，否则尾盘强平',
			'signal平回=反向触发价平掉全部反向旧仓；B092=本腿+1.4T止盈/-0.5T止损；control=尾盘必平',
			'允许卖穿底仓但禁止负库存；同向卖出需净库存足够一笔1万元'
		],
		汇总_合并种子: summary,
		分种子: bySeed,
		配对_合并种子: combinedPairs,
		下行期单笔风险_2022至2024: downPeriod
	}, null, 2));

	console.log('\n=== 汇总（合并种子）===');
	console.table(summary);
	console.log('\n=== 合并种子配对 ===');
	console.table(combinedPairs);
	console.log('\n=== 2022~2024 下行期单笔风险 ===');
	console.table(downPeriod);
	console.log(`\n输出目录: ${OUT_DIR}`);
}

main();
