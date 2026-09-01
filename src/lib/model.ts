import type { Model } from './types';

export type Zone = 'extreme_low' | 'low' | 'normal' | 'high' | 'extreme_high';

export interface BandsOfToday {
	trend: number;
	high95: number;
	low05: number;
	high99: number;
	low01: number;
	days: number;
}

export const EXPECTED_MIN = 1.0;
export const EXPECTED_MAX = 2.0;

export function round(x: number, d = 4): number {
	const f = 10 ** d;
	return Math.round(x * f) / f;
}

export function daysFromBase(dateStr: string, baseDate: string): number {
	return Math.round(
		(new Date(dateStr + 'T00:00:00Z').getTime() - new Date(baseDate + 'T00:00:00Z').getTime()) /
			86400000
	);
}

export function addDays(dateStr: string, days: number): string {
	const d = new Date(dateStr + 'T00:00:00Z');
	d.setUTCDate(d.getUTCDate() + days);
	return d.toISOString().slice(0, 10);
}

export function trendValue(model: Model, days: number): number {
	return model.intercept + model.slope * days;
}

export function calcBands(model: Model, dateStr: string): BandsOfToday {
	const days = daysFromBase(dateStr, model.baseDate);
	const trend = trendValue(model, days);
	return {
		trend,
		high95: trend + model.bands.high95,
		low05: trend + model.bands.low05,
		high99: trend + model.bands.high99,
		low01: trend + model.bands.low01,
		days
	};
}

export function getZone(price: number, bands: BandsOfToday): Zone {
	if (price < bands.low01) return 'extreme_low';
	if (price < bands.low05) return 'low';
	if (price > bands.high99) return 'extreme_high';
	if (price > bands.high95) return 'high';
	return 'normal';
}

export function isValidPrice(price: number): boolean {
	return price >= EXPECTED_MIN && price <= EXPECTED_MAX;
}
