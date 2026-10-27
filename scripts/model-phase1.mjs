/**
 * 第一阶段：最近一年窗口（2025-10-21 ~ 2026-10-21）大体测试
 *  - 基线方案（与原实验逐参数一致）作对照
 *  - 模型A：手工设计的宽通道·高门槛配置 5 组
 *  - 模型B：参数空间固定种子随机搜索 400 组，按全年年化排名
 * 输出完整排名与 Top8 候选到 backtest/20261027-models/，供第二阶段全历史验证
 *
 * 用法: node scripts/model-phase1.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	BASELINE, INIT_CASH, BASE_SHARES, loadData, buildDayModels, run,
	dayNumBetween, rng
} from './model-lib.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'backtest', '20261027-models');
const TEST_START = '2025-10-21'; // 最近一年窗口起点
const SEARCH_N = 400;
const SEED_B = 20261027;
const TOP_KEEP = 8;

// —— 模型A：宽通道·高门槛手工配置 ——
const MODEL_A = [
	{
		name: 'A1_宽15/85_T×0.65_过夜',
		zoneP: 0.15, extremeP: 0.05, tK: 0.65, tMin: 0.007, tMax: 0.015,
		zoneRatio: 0.85, zoneTMin: 0.006, zoneTMax: 0.012,
		zoneCooldown: 5, tExit: 'hold', holdTargetK: 1.0, holdStopK: 0.5, holdMaxDays: 5
	},
	{
		name: 'A2_宽15/85_T×0.65_不过夜',
		zoneP: 0.15, extremeP: 0.05, tK: 0.65, tMin: 0.007, tMax: 0.015,
		zoneRatio: 0.85, zoneTMin: 0.006, zoneTMax: 0.012,
		zoneCooldown: 5, tExit: 'sameDay', holdTargetK: 1.0, holdStopK: 0.5, holdMaxDays: 5
	},
	{
		name: 'A3_宽10/90_T×0.60_过夜_冷却3',
		zoneP: 0.10, extremeP: 0.03, tK: 0.6, tMin: 0.006, tMax: 0.012,
		zoneRatio: 0.85, zoneTMin: 0.005, zoneTMax: 0.010,
		zoneCooldown: 3, tExit: 'hold', holdTargetK: 1.0, holdStopK: 0.5, holdMaxDays: 5
	},
	{
		name: 'A4_宽20/80_T×0.75_过夜_冷却10',
		zoneP: 0.20, extremeP: 0.07, tK: 0.75, tMin: 0.008, tMax: 0.018,
		zoneRatio: 0.9, zoneTMin: 0.007, zoneTMax: 0.014,
		zoneCooldown: 10, tExit: 'hold', holdTargetK: 1.0, holdStopK: 0.5, holdMaxDays: 5
	},
	{
		name: 'A5_宽15/85_T×0.65_过夜_宽止盈',
		zoneP: 0.15, extremeP: 0.05, tK: 0.65, tMin: 0.007, tMax: 0.015,
		zoneRatio: 0.85, zoneTMin: 0.006, zoneTMax: 0.012,
		zoneCooldown: 5, tExit: 'hold', holdTargetK: 1.5, holdStopK: 0.75, holdMaxDays: 10
	}
];

// —— 模型B：随机搜索空间 ——
function sampleCfg(rand) {
	const u = (lo, hi) => lo + rand() * (hi - lo);
	const pick = (arr) => arr[Math.floor(rand() * arr.length)];
	const zoneP = u(0.05, 0.25);
	const extremeP = u(0.01, Math.min(zoneP, 0.1));
	const tK = u(0.45, 0.95);
	const tMin = u(0.004, 0.012);
	const tMax = u(tMin + 0.002, 0.02);
	return {
		name: '',
		zoneP, extremeP, tK, tMin, tMax,
		ampWindow: pick([10, 20, 40, 60]),
		ampQ: u(0.3, 0.7),
		zoneRatio: u(0.6, 1.0),
		zoneTMin: Math.max(0.003, tMin * 0.8),
		zoneTMax: Math.max(0.006, Math.min(tMax * 0.9, 0.016)),
		zoneCooldown: pick([0, 3, 5, 10]),
		tExit: pick(['sameDay', 'hold']),
		holdTargetK: u(0.8, 1.6),
		holdStopK: u(0.3, 0.8),
		holdMaxDays: pick([3, 5, 10])
	};
}

const fmtCfg = (c) =>
	`zoneP=${c.zoneP.toFixed(2)} extP=${c.extremeP.toFixed(2)} tK=${c.tK.toFixed(2)} ` +
	`amp=${c.ampWindow ?? 20}日×Q${(c.ampQ ?? 0.5).toFixed(2)} ` +
	`T=[${(c.tMin * 100).toFixed(1)}%,${(c.tMax * 100).toFixed(1)}%] zR=${c.zoneRatio.toFixed(2)} ` +
	`cd=${c.zoneCooldown} ${c.tExit}` +
	(c.tExit === 'hold' ? ` tgt=${c.holdTargetK.toFixed(1)} stop=${c.holdStopK.toFixed(1)} max${c.holdMaxDays}d` : '');

/** 窗口 [startIdx, endExcl) 的独立模拟（endExcl=null 表示持有250日或到数据末） */
function evalWindow(cfg, startIdx, days, models, ampHist, endExcl = null) {
	const { cash, shares, endIdx, tStats } = run(cfg, startIdx, days, models, endExcl, ampHist);
	const d0 = days[startIdx];
	const startEq = INIT_CASH + BASE_SHARES * d0.open;
	const endEq = cash + shares * days[endIdx].close;
	const calDays = dayNumBetween(d0.date, days[endIdx].date);
	const ann = (endEq / startEq) ** (365.25 / calDays) - 1;
	return { ret: endEq / startEq - 1, ann, endIdx, tStats };
}

function main() {
	const { days, allWeeks } = loadData('2019-12-20');
	const { models, ampHist } = buildDayModels(days, allWeeks);
	const startIdx = days.findIndex((d) => d.date >= TEST_START);
	const endIdx = days.length - 1;
	const midIdx = startIdx + Math.floor((endIdx - startIdx) / 2);
	console.log(`第一阶段窗口: ${days[startIdx].date} ~ ${days[endIdx].date}（${endIdx - startIdx + 1} 个交易日）`);

	const holdRet = days[endIdx].close / days[startIdx].open - 1;
	const calDays = dayNumBetween(days[startIdx].date, days[endIdx].date);
	const holdAnn = (1 + holdRet) ** (365.25 / calDays) - 1;

	const results = [];
	const evalOne = (cfg, tag) => {
		const full = evalWindow(cfg, startIdx, days, models, ampHist);
		const h1 = evalWindow(cfg, startIdx, days, models, ampHist, midIdx + 1); // 前半
		const h2 = evalWindow(cfg, midIdx + 1, days, models, ampHist); // 后半（新起点）
		results.push({ cfg: { ...cfg }, tag, ...full, h1: h1.ann, h2: h2.ann, twoHalfMin: Math.min(h1.ann, h2.ann) });
	};

	evalOne(BASELINE, 'baseline');
	for (const a of MODEL_A) evalOne(a, 'modelA');

	const rand = rng(SEED_B);
	const seen = new Set();
	for (let k = 0; k < SEARCH_N; k++) {
		const c = sampleCfg(rand);
		const key = JSON.stringify(c);
		if (seen.has(key)) continue;
		seen.add(key);
		c.name = `B${String(k).padStart(3, '0')}`;
		evalOne(c, 'modelB');
	}

	// 主排序：全年年化；并列参考：两个半年最低年化（防单段过拟合）
	results.sort((a, b) => b.ann - a.ann || b.twoHalfMin - a.twoHalfMin);

	const rows = results.map((r, i) => ({
		排名: i + 1, 标签: r.tag,
		配置: r.tag === 'modelB' ? `${r.cfg.name} ${fmtCfg(r.cfg)}` : r.cfg.name,
		收益率: (r.ret * 100).toFixed(2) + '%', 年化: (r.ann * 100).toFixed(2) + '%',
		半年最低: (r.twoHalfMin * 100).toFixed(2) + '%',
		T次数: r.tStats.tCount, T胜率: (r.tStats.tWinRate * 100).toFixed(1) + '%',
		T净收益: r.tStats.tProfit.toFixed(0), 尾盘不利平回: r.tStats.tFailClose
	}));

	mkdirSync(OUT_DIR, { recursive: true });
	const csv = [
		'rank,tag,name,params,return_pct,annualized_pct,half_min_pct,t_count,t_winrate_pct,t_profit,t_failclose,zone_buys,zone_sells',
		...results.map((r, i) =>
			`${i + 1},${r.tag},${r.cfg.name},"${fmtCfg(r.cfg)}",${(r.ret * 100).toFixed(2)},${(r.ann * 100).toFixed(2)},${(r.twoHalfMin * 100).toFixed(2)},${r.tStats.tCount},${(r.tStats.tWinRate * 100).toFixed(1)},${r.tStats.tProfit.toFixed(0)},${r.tStats.tFailClose},${r.tStats.zoneBuyCount},${r.tStats.zoneSellCount}`
		)
	].join('\n');
	writeFileSync(join(OUT_DIR, 'phase1-ranking.csv'), csv + '\n');

	const candidates = results.slice(0, TOP_KEEP).map((r) => ({ name: r.cfg.name, tag: r.tag, cfg: r.cfg }));
	writeFileSync(join(OUT_DIR, 'phase1-candidates.json'), JSON.stringify(candidates, null, 2) + '\n');

	console.table(rows.slice(0, 20));
	console.log(`\n基线: 年化 ${(results.find((r) => r.tag === 'baseline').ann * 100).toFixed(2)}% | 纯持有参照: ${(holdAnn * 100).toFixed(2)}%`);
	console.log(`共评估 ${results.length} 个配置，Top${TOP_KEEP} 候选已写入 ${OUT_DIR}`);
}

try {
	main();
} catch (e) {
	console.error(e);
	process.exit(1);
}
