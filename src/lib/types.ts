export interface HistoryPoint {
	date: string;
	price: number;
	trend: number;
	high95: number;
	low05: number;
	high99: number;
	low01: number;
}

export interface Bands {
	high95: number;
	low05: number;
	high99: number;
	low01: number;
}

export interface Model {
	baseDate: string;
	intercept: number;
	slope: number;
	bands: Bands;
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
