/**
 * 第二阶段：Top 候选全历史稳定性验证
 *  - 数据源与口径同 20261022-stability-full：iFinD 前复权日线（2019-12-20 上市起），
 *    全历史有效建仓日按建仓年份分层抽样 N=200（种子 20261027）
 *  - 对比：基线、第一阶段 Top5 候选（模型B寻优）、模型A最优代表 A1、纯持有参照
 *  - 每个样本持有 250 个交易日；另按"是否与第一阶段选样窗口重叠"分组，
 *    检验选股配置在任意建仓周期上是否稳定优于基线（控制选择偏差可见性）
 *
 * 用法: node scripts/model-phase2.mjs [样本数N，默认200]
 */
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	BASELINE, INIT_CASH, BASE_SHARES, loadData, buildDayModels, run,
	dayNumBetween, sampleStratified, summarizeAnns, HOLD_DAYS
} from './model-lib.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const N = parseInt(process.argv[2] ?? '200', 10);
const SEED = parseInt(process.argv[3] ?? '20261027', 10);
const OUT_TAG = process.argv[4] ?? '20261027-models-full';
const OUT_DIR = join(ROOT, 'backtest', OUT_TAG);
const SEL_WIN = ['2025-10-21', '2026-10-21']; // 第一阶段选样窗口

// 追加对照：固定股数口径下已通过验证的 B092/B223（检验口径切换后稳健性）、模型A最优 A3
const EXTRA = [
	{
		name: 'B092(股数口径已验证)',
		zoneP: 0.23, extremeP: 0.02, tK: 0.58, tMin: 0.004, tMax: 0.015,
		ampWindow: 60, ampQ: 0.33,
		zoneRatio: 0.63, zoneTMin: 0.004, zoneTMax: 0.012,
		zoneCooldown: 0, tExit: 'hold', holdTargetK: 1.4, holdStopK: 0.5, holdMaxDays: 5
	},
	{
		name: 'B223(股数口径已验证)',
		zoneP: 0.22, extremeP: 0.08, tK: 0.59, tMin: 0.005, tMax: 0.02,
		ampWindow: 20, ampQ: 0.48,
		zoneRatio: 0.62, zoneTMin: 0.004, zoneTMax: 0.012,
		zoneCooldown: 0, tExit: 'hold', holdTargetK: 1.6, holdStopK: 0.4, holdMaxDays: 5
	},
	{
		name: 'A3_宽10/90_T×0.60_过夜(模型A最优)',
		zoneP: 0.10, extremeP: 0.03, tK: 0.60, tMin: 0.006, tMax: 0.012,
		ampWindow: 20, ampQ: 0.5,
		zoneRatio: 0.85, zoneTMin: 0.005, zoneTMax: 0.010,
		zoneCooldown: 3, tExit: 'hold', holdTargetK: 1.0, holdStopK: 0.5, holdMaxDays: 5
	}
];

const fmt = (x) => x.toFixed(2); // rows.ann 已是百分数，不再缩放

function main() {
	const cands = JSON.parse(readFileSync(join(ROOT, 'backtest', '20261027-models', 'phase1-candidates.json'), 'utf8'));
	const top5 = cands.slice(0, 5).map((c) => ({
		name: `${c.cfg.name}(${c.tag})`,
		...c.cfg
	}));
	const configs = [
		{ name: BASELINE.name, ...BASELINE },
		...top5,
		...EXTRA
	];

	const { days, allWeeks } = loadData('2019-12-20');
	const { models, ampHist } = buildDayModels(days, allWeeks);
	const valid = [];
	for (let i = 0; i + HOLD_DAYS < days.length; i++) if (models[i]) valid.push(i);
	const picked = sampleStratified(valid, days, Math.min(N, valid.length), SEED);
	console.log(`全历史有效起点 ${valid.length} 个（${days[valid[0]].date} ~ ${days[valid.at(-1)].date}），分层抽样 ${picked.length} 个`);

	const rows = [];
	for (const i of picked) {
		const d0 = days[i];
		const startEq = INIT_CASH + BASE_SHARES * d0.open;
		const endIdx = Math.min(i + HOLD_DAYS, days.length) - 1;
		const calDays = dayNumBetween(d0.date, days[endIdx].date);
		const overlap = d0.date <= SEL_WIN[1] && days[endIdx].date >= SEL_WIN[0];
		for (const cfg of configs) {
			const { cash, shares, endIdx: e, tStats } = run(cfg, i, days, models, null, ampHist);
			const endEq = cash + shares * days[e].close;
			const ann = ((endEq / startEq) ** (365.25 / calDays) - 1) * 100;
			rows.push({
				start: d0.date, end: days[e].date, overlap, strategy: cfg.name,
				ret: +((endEq / startEq - 1) * 100).toFixed(2), ann: +ann.toFixed(2),
				tCount: tStats.tCount, tWinRate: tStats.tWinRate, tProfit: Math.round(tStats.tProfit),
				tFail: tStats.tFailClose, zb: tStats.zoneBuyCount, zs: tStats.zoneSellCount
			});
		}
		const holdAnn = ((INIT_CASH + BASE_SHARES * days[endIdx].close) / startEq) ** (365.25 / calDays) * 100 - 100;
		rows.push({
			start: d0.date, end: days[endIdx].date, overlap, strategy: 'hold_纯持有(参照)',
			ret: +((days[endIdx].close / d0.open - 1) * 100).toFixed(2), ann: +holdAnn.toFixed(2),
			tCount: 0, tWinRate: 0, tProfit: 0, tFail: 0, zb: 0, zs: 0
		});
	}

	const stratNames = [...configs.map((c) => c.name), 'hold_纯持有(参照)'];
	const summary = stratNames.map((name) => {
		const rs = rows.filter((r) => r.strategy === name);
		const s = summarizeAnns(rs.map((r) => r.ann));
		const avgT = rs.reduce((a, r) => a + r.tCount, 0) / rs.length;
		const avgWin = rs.reduce((a, r) => a + r.tWinRate, 0) / rs.length;
		const avgProfit = rs.reduce((a, r) => a + r.tProfit, 0) / rs.length;
		const avgFail = rs.reduce((a, r) => a + r.tFail, 0) / rs.length;
		const avgZb = rs.reduce((a, r) => a + r.zb, 0) / rs.length;
		const avgZs = rs.reduce((a, r) => a + r.zs, 0) / rs.length;
		return {
			策略: name,
			样本数: s.n,
			年化均值: fmt(s.mean) + '%',
			中位数: fmt(s.median) + '%',
			标准差: fmt(s.std) + '%',
			均值标准差比: s.sharpe.toFixed(2),
			最差: fmt(s.worst) + '%',
			P亏损: (s.pLoss * 100).toFixed(1) + '%',
			P超10: (s.p10pct * 100).toFixed(1) + '%',
			P超20: (s.p20pct * 100).toFixed(1) + '%',
			平均T次数: avgT.toFixed(1),
			平均T胜率: (avgWin * 100).toFixed(1) + '%',
			平均T净收益: avgProfit.toFixed(0),
			平均尾盘不利平回: avgFail.toFixed(1),
			平均区买: avgZb.toFixed(1),
			平均区卖: avgZs.toFixed(1)
		};
	});

	// 与选样窗口重叠分组（检验选择偏差）
	const splitSummary = stratNames.map((name) => {
		const ov = rows.filter((r) => r.strategy === name && r.overlap);
		const no = rows.filter((r) => r.strategy === name && !r.overlap);
		const so = summarizeAnns(ov.map((r) => r.ann));
		const sn = summarizeAnns(no.map((r) => r.ann));
		return {
			策略: name,
			重叠样本: ov.length,
			重叠均值: fmt(so.mean) + '%',
			非重叠样本: no.length,
			非重叠均值: fmt(sn.mean) + '%',
			非重叠中位: fmt(sn.median) + '%',
			非重叠最差: fmt(sn.worst) + '%'
		};
	});

	// 逐样本配对优势：候选 vs 基线同年化差值
	const baseByStart = {};
	for (const r of rows) if (r.strategy === BASELINE.name) baseByStart[r.start + r.end] = r.ann;
	const paired = configs.map((c) => {
		const diffs = rows.filter((r) => r.strategy === c.name).map((r) => r.ann - baseByStart[r.start + r.end]);
		const win = diffs.filter((d) => d > 0).length;
		return {
			策略: c.name,
			配对样本: diffs.length,
			胜基线占比: ((win / diffs.length) * 100).toFixed(1) + '%',
			平均年化差: (diffs.reduce((a, b) => a + b, 0) / diffs.length).toFixed(2) + 'pp'
		};
	});

	mkdirSync(OUT_DIR, { recursive: true });
	const csv = [
		'start,end,overlap,strategy,return_pct,annualized_pct,t_count,t_winrate,t_profit,t_failclose,zone_buys,zone_sells',
		...rows.map((r) =>
			`${r.start},${r.end},${r.overlap},"${r.strategy}",${r.ret},${r.ann},${r.tCount},${(r.tWinRate * 100).toFixed(1)},${r.tProfit},${r.tFail},${r.zb},${r.zs}`
		)
	].join('\n');
	writeFileSync(join(OUT_DIR, 'samples.csv'), csv + '\n');
	writeFileSync(
		join(OUT_DIR, 'report.json'),
		JSON.stringify({
			实验: '模型A/B 全历史稳定性验证：iFinD 前复权日线 2019-12-20 上市起，建仓年份分层抽样×持有250交易日',
			种子: SEED,
			选样窗口重叠说明: `第一阶段候选按 ${SEL_WIN[0]}~${SEL_WIN[1]} 年化选出；本节按样本持有窗口是否与该区间重叠分组，非重叠组为无偏验证`,
			汇总: summary,
			重叠分组: splitSummary,
			配对优势: paired
		}, null, 2) + '\n'
	);

	console.table(summary);
	console.log('\n=== 选样窗口重叠分组 ===');
	console.table(splitSummary);
	console.log('\n=== 逐样本配对（vs 基线）===');
	console.table(paired);
	console.log(`\n输出: ${OUT_DIR}/{samples.csv, report.json}`);
}

try {
	main();
} catch (e) {
	console.error(e);
	process.exit(1);
}
