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
const B092_CFG = {
	name: 'B092(股数口径已验证)',
	zoneP: 0.23, extremeP: 0.02, tK: 0.58, tMin: 0.004, tMax: 0.015,
	ampWindow: 60, ampQ: 0.33,
	zoneRatio: 0.63, zoneTMin: 0.004, zoneTMax: 0.012,
	zoneCooldown: 0, tExit: 'hold', holdTargetK: 1.4, holdStopK: 0.5, holdMaxDays: 5
};
const B223_CFG = {
	name: 'B223(股数口径已验证)',
	zoneP: 0.22, extremeP: 0.08, tK: 0.59, tMin: 0.005, tMax: 0.02,
	ampWindow: 20, ampQ: 0.48,
	zoneRatio: 0.62, zoneTMin: 0.004, zoneTMax: 0.012,
	zoneCooldown: 0, tExit: 'hold', holdTargetK: 1.6, holdStopK: 0.4, holdMaxDays: 5
};
const A3_CFG = {
	name: 'A3_宽10/90_T×0.60_过夜(模型A最优)',
	zoneP: 0.10, extremeP: 0.03, tK: 0.60, tMin: 0.006, tMax: 0.012,
	ampWindow: 20, ampQ: 0.5,
	zoneRatio: 0.85, zoneTMin: 0.005, zoneTMax: 0.010,
	zoneCooldown: 3, tExit: 'hold', holdTargetK: 1.0, holdStopK: 0.5, holdMaxDays: 5
};
const EXTRA = [B092_CFG, B223_CFG, A3_CFG];

// 20261027-signal-close：B092 参数逐字段不变，只把平仓机制换成 signal/H3
const SIGNAL_COMMON = {
	zoneP: B092_CFG.zoneP,
	extremeP: B092_CFG.extremeP,
	tK: B092_CFG.tK,
	tMin: B092_CFG.tMin,
	tMax: B092_CFG.tMax,
	ampWindow: B092_CFG.ampWindow,
	ampQ: B092_CFG.ampQ,
	zoneRatio: B092_CFG.zoneRatio,
	zoneTMin: B092_CFG.zoneTMin,
	zoneTMax: B092_CFG.zoneTMax,
	zoneCooldown: B092_CFG.zoneCooldown,
	holdMaxDays: B092_CFG.holdMaxDays
};
const S_SIGNAL_CFG = {
	name: 'S-signal(信号平回,B092参数)',
	...SIGNAL_COMMON,
	tExit: 'signal',
	signalReopen: false
};
const S_SIGNAL_H3_CFG = {
	name: 'S-signal-H3(平回后再开仓,B092参数)',
	...SIGNAL_COMMON,
	tExit: 'signal',
	signalReopen: true
};
const IS_SIGNAL_CLOSE = OUT_TAG.includes('signal-close');

const fmt = (x) => x.toFixed(2); // rows.ann 已是百分数，不再缩放
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const median = (xs) => {
	if (!xs.length) return 0;
	const s = [...xs].sort((a, b) => a - b);
	const mid = Math.floor(s.length / 2);
	return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

function pairedAgainst(rows, strategyNames, targetName) {
	const targetByStart = {};
	for (const r of rows) {
		if (r.strategy === targetName) targetByStart[r.start + r.end] = r.ann;
	}
	return strategyNames
		.filter((name) => name !== targetName)
		.map((name) => {
			const diffs = rows
				.filter((r) => r.strategy === name && targetByStart[r.start + r.end] !== undefined)
				.map((r) => r.ann - targetByStart[r.start + r.end]);
			return {
				策略: name,
				配对样本: diffs.length,
				[`胜${targetName}占比`]: ((diffs.filter((d) => d > 0).length / diffs.length) * 100).toFixed(1) + '%',
				平均年化差: mean(diffs).toFixed(2) + 'pp'
			};
		});
}

function summarizeDownPeriod(tradesByStrategy, strategyNames) {
	// 风险专项：按退出日落在 2022~2024 的 T 笔统计；重叠样本中的同一历史波段会重复计入
	return strategyNames.map((name) => {
		const ts = (tradesByStrategy.get(name) ?? []).filter(
			(t) => t.exitDate >= '2022-01-01' && t.exitDate <= '2024-12-31'
		);
		const nets = ts.map((t) => t.net);
		const losses = nets.filter((x) => x < 0);
		return {
			策略: name,
			样本笔数: ts.length,
			亏损笔数: losses.length,
			亏损率: ts.length ? ((losses.length / ts.length) * 100).toFixed(1) + '%' : '0.0%',
			平均单笔净盈亏: mean(nets).toFixed(0),
			中位单笔净盈亏: median(nets).toFixed(0),
			最差单笔: nets.length ? Math.min(...nets).toFixed(0) : '0',
			P10单笔: nets.length ? [...nets].sort((a, b) => a - b)[Math.floor(0.1 * (nets.length - 1))].toFixed(0) : '0'
		};
	});
}

function main() {
	let configs;
	if (IS_SIGNAL_CLOSE) {
		configs = [
			{ name: BASELINE.name, ...BASELINE },
			{ ...B092_CFG },
			{ ...S_SIGNAL_CFG },
			{ ...S_SIGNAL_H3_CFG }
		];
	} else {
		const cands = JSON.parse(readFileSync(join(ROOT, 'backtest', '20261027-models', 'phase1-candidates.json'), 'utf8'));
		const top5 = cands.slice(0, 5).map((c) => ({
			name: `${c.cfg.name}(${c.tag})`,
			...c.cfg
		}));
		configs = [
			{ name: BASELINE.name, ...BASELINE },
			...top5,
			...EXTRA
		];
	}

	const { days, allWeeks } = loadData('2019-12-20');
	const { models, ampHist } = buildDayModels(days, allWeeks);
	const valid = [];
	for (let i = 0; i + HOLD_DAYS < days.length; i++) if (models[i]) valid.push(i);
	const picked = sampleStratified(valid, days, Math.min(N, valid.length), SEED);
	console.log(`全历史有效起点 ${valid.length} 个（${days[valid[0]].date} ~ ${days[valid.at(-1)].date}），分层抽样 ${picked.length} 个`);

	const stratNames = [...configs.map((c) => c.name), 'hold_纯持有(参照)'];
	const tradesByStrategy = new Map(stratNames.map((name) => [name, []]));
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
			// noT 对照：同一 Zone 交易路径下禁用新开 T，做T贡献=期末权益差及年化差
			const noT = run({ ...cfg, noT: true }, i, days, models, null, ampHist);
			const noTEndEq = noT.cash + noT.shares * days[noT.endIdx].close;
			const annNoT = ((noTEndEq / startEq) ** (365.25 / calDays) - 1) * 100;
			const exits = tStats.tExitCounts;
			rows.push({
				start: d0.date, end: days[e].date, overlap, strategy: cfg.name,
				ret: +((endEq / startEq - 1) * 100).toFixed(2), ann: +ann.toFixed(2),
				annNoT: +annNoT.toFixed(2), tNetEq: Math.round(endEq - noTEndEq),
				tNetAnnDiff: +(ann - annNoT).toFixed(2),
				tCount: tStats.tCount, tWinRate: tStats.tWinRate, tProfit: Math.round(tStats.tProfit),
				tHoldDays: tStats.tHoldDays, tMaxLoss: Math.round(tStats.tMaxLoss),
				tFail: tStats.tFailClose, tForce: tStats.tForceClose,
				exSameDay: exits.sameDay, exSignal: exits.signal, exTarget: exits.target,
				exStop: exits.stop, exForce: exits.force, exEnd: exits.end,
				zb: tStats.zoneBuyCount, zs: tStats.zoneSellCount
			});
			tradesByStrategy.get(cfg.name).push(...tStats.trades);
		}
		const holdAnn = ((INIT_CASH + BASE_SHARES * days[endIdx].close) / startEq) ** (365.25 / calDays) * 100 - 100;
		rows.push({
			start: d0.date, end: days[endIdx].date, overlap, strategy: 'hold_纯持有(参照)',
			ret: +((days[endIdx].close / d0.open - 1) * 100).toFixed(2), ann: +holdAnn.toFixed(2),
			annNoT: +holdAnn.toFixed(2), tNetEq: 0, tNetAnnDiff: 0,
			tCount: 0, tWinRate: 0, tProfit: 0, tHoldDays: 0, tMaxLoss: 0,
			tFail: 0, tForce: 0, exSameDay: 0, exSignal: 0, exTarget: 0, exStop: 0,
			exForce: 0, exEnd: 0, zb: 0, zs: 0
		});
	}

	const summary = stratNames.map((name) => {
		const rs = rows.filter((r) => r.strategy === name);
		const s = summarizeAnns(rs.map((r) => r.ann));
		const totalT = rs.reduce((a, r) => a + r.tCount, 0);
		const totalProfit = rs.reduce((a, r) => a + r.tProfit, 0);
		const totalHold = rs.reduce((a, r) => a + r.tHoldDays, 0);
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
			年均笔数: mean(rs.map((r) => r.tCount)).toFixed(1),
			年均胜率: (mean(rs.map((r) => r.tWinRate)) * 100).toFixed(1) + '%',
			单笔期望元: totalT ? (totalProfit / totalT).toFixed(0) : '0',
			最大单笔亏损元: rs.length ? Math.min(...rs.map((r) => r.tMaxLoss)).toFixed(0) : '0',
			平均持仓天数: totalT ? (totalHold / totalT).toFixed(1) : '0.0',
			年均尾盘强平: mean(rs.map((r) => r.tForce)).toFixed(1),
			年均区买: mean(rs.map((r) => r.zb)).toFixed(1),
			年均区卖: mean(rs.map((r) => r.zs)).toFixed(1),
			年均T净收益元: mean(rs.map((r) => r.tProfit)).toFixed(0),
			做T净收益元_noT差值: mean(rs.map((r) => r.tNetEq)).toFixed(0),
			做T年化差pp_noT差值: mean(rs.map((r) => r.tNetAnnDiff)).toFixed(2)
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

	const pairedVsBaseline = pairedAgainst(rows, stratNames, BASELINE.name);
	const pairedVsB092 = IS_SIGNAL_CLOSE ? pairedAgainst(rows, stratNames, B092_CFG.name) : null;
	// 兼容原模型实验的配对输出格式
	const paired = IS_SIGNAL_CLOSE
		? pairedVsBaseline
		: configs.map((c) => {
			const diffs = rows
				.filter((r) => r.strategy === c.name)
				.map((r) => r.ann - rows.find((b) => b.strategy === BASELINE.name && b.start === r.start && b.end === r.end).ann);
			return {
				策略: c.name,
				配对样本: diffs.length,
				胜基线占比: ((diffs.filter((d) => d > 0).length / diffs.length) * 100).toFixed(1) + '%',
				平均年化差: mean(diffs).toFixed(2) + 'pp'
			};
		});
	const downPeriod = IS_SIGNAL_CLOSE ? summarizeDownPeriod(tradesByStrategy, stratNames) : null;

	mkdirSync(OUT_DIR, { recursive: true });
	const csv = [
		'start,end,overlap,strategy,return_pct,annualized_pct,annualized_noT_pct,t_net_eq_diff,t_net_ann_diff_pp,t_count,t_winrate,t_profit,t_holddays,t_maxloss,t_failclose,t_forceclose,t_exit_sameday,t_exit_signal,t_exit_target,t_exit_stop,t_exit_force,t_exit_end,zone_buys,zone_sells',
		...rows.map((r) =>
			`${r.start},${r.end},${r.overlap},"${r.strategy}",${r.ret},${r.ann},${r.annNoT},${r.tNetEq},${r.tNetAnnDiff},${r.tCount},${(r.tWinRate * 100).toFixed(1)},${r.tProfit},${r.tHoldDays},${r.tMaxLoss},${r.tFail},${r.tForce},${r.exSameDay},${r.exSignal},${r.exTarget},${r.exStop},${r.exForce},${r.exEnd},${r.zb},${r.zs}`
		)
	].join('\n');
	writeFileSync(join(OUT_DIR, 'samples.csv'), csv + '\n');

	const report = {
		实验: IS_SIGNAL_CLOSE
			? '隔夜T平仓机制对比：baseline / B092价格平回 / S-signal信号平回 / S-signal-H3；iFinD 前复权日线，建仓年份分层抽样×持有250交易日'
			: '模型A/B 全历史稳定性验证：iFinD 前复权日线 2019-12-20 上市起，建仓年份分层抽样×持有250交易日',
		种子: SEED,
		选样窗口重叠说明: `第一阶段候选按 ${SEL_WIN[0]}~${SEL_WIN[1]} 年化选出；本节按样本持有窗口是否与该区间重叠分组，非重叠组为无偏验证`,
		汇总: summary,
		重叠分组: splitSummary,
		配对优势: paired,
		...(IS_SIGNAL_CLOSE ? { 配对优势vsB092: pairedVsB092, 下行期单笔风险_2022至2024: downPeriod } : {})
	};
	writeFileSync(join(OUT_DIR, 'report.json'), JSON.stringify(report, null, 2) + '\n');
	if (IS_SIGNAL_CLOSE) {
		writeFileSync(
			join(OUT_DIR, 'README.md'),
			`# ${OUT_TAG} — signal-close 阶段二数据（种子 ${SEED}）\n\n` +
			'本目录是 [20261027-signal-close 隔夜T平仓机制对比](../20261027-signal-close/README.md) 的原始输出。\n\n' +
			'- `samples.csv`：逐样本收益、年化、noT 对照差、T 笔数/胜率/逐笔汇总、强平与区交易次数\n' +
			'- `report.json`：汇总、配对优势（vs baseline / vs B092）、2022~2024 下行期单笔风险\n\n' +
			`复现：node scripts/model-phase2.mjs ${N} ${SEED} ${OUT_TAG}\n`
		);
	}

	console.table(summary);
	console.log('\n=== 选样窗口重叠分组 ===');
	console.table(splitSummary);
	console.log(`\n=== 逐样本配对（vs ${IS_SIGNAL_CLOSE ? '基线' : '基线'}）===`);
	console.table(paired);
	if (IS_SIGNAL_CLOSE) {
		console.log('\n=== 逐样本配对（vs B092）===');
		console.table(pairedVsB092);
		console.log('\n=== 2022~2024 下行期 T 单笔风险 ===');
		console.table(downPeriod);
	}
	console.log(`\n输出: ${OUT_DIR}/{samples.csv, report.json}`);
}

try {
	main();
} catch (e) {
	console.error(e);
	process.exit(1);
}
