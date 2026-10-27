export interface HistoryPoint {
	date: string;
	price: number;
}

export interface Bands {
	high95: number;
	low05: number;
	high99: number;
	low01: number;
}

/** 一次完整的趋势通道拟合结果（截距、斜率、残差分位数通道偏移） */
export interface ModelFit {
	intercept: number;
	slope: number;
	bands: Bands;
}

export interface TSignal {
	normal: number; // 正常区做T阈值（小数，如 0.005）
	zone: number; // 低估/高估区加减仓阈值
	medianAmp: number; // 近 windowDays 日日内振幅中位数
	windowDays: number;
}

/**
 * 模型三「B092 优化版」（20261027 全历史验证最优，回测年化均值≈41% vs 原方案≈33%）：
 * 同用近期加权拟合，但通道放宽到 23%/77%（极端 2%/98%），加减仓信号更多；
 * T 阈值 = 近60日振幅 Q0.33 × 0.58（限 0.4%~1.5%），区触发 ×0.63；
 * T 单允许过夜（目标 +T×1.4、止损 −T×0.5、最长 5 日），不再尾盘强制平回；每笔固定 1 万元。
 */
export interface OptimizedModel {
	fit: ModelFit; // bands 实为 77/23/98/2 分位（字段名沿用 Bands 结构）
	tSignal: TSignal;
}

export interface Model {
	baseDate: string;
	adjusted: boolean; // 历史数据是否为前复权（false 时模型受分红影响，需警惕）
	halfLifeWeeks: number; // 「近期加权」模式的半衰期（周）
	effectiveN: number; // 加权模式下的等效样本量（等权模式即 history.length）
	weighted: ModelFit; // 近期加权拟合（问题三）
	unweighted: ModelFit; // 等权全样本拟合（原算法）
	tSignal: TSignal;
	optimized: OptimizedModel; // 模型三：B092 优化版（默认选中）
}

export interface HistoryResponse extends Model {
	history: HistoryPoint[];
}

export interface Quote {
	price: number;
	open: number;
	high: number;
	low: number;
	name: string;
	source: string;
	time: string;
}
