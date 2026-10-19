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

export interface Model {
	baseDate: string;
	adjusted: boolean; // 历史数据是否为前复权（false 时模型受分红影响，需警惕）
	halfLifeWeeks: number; // 「近期加权」模式的半衰期（周）
	effectiveN: number; // 加权模式下的等效样本量（等权模式即 history.length）
	weighted: ModelFit; // 近期加权拟合（问题三）
	unweighted: ModelFit; // 等权全样本拟合（原算法）
	tSignal: TSignal;
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
