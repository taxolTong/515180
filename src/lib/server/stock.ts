import type { HistoryPoint, HistoryResponse, Quote } from '$lib/types';
import { round } from '$lib/model';

const START_DATE = '2024-09-01';
const HISTORY_TTL = 60 * 60 * 1000; // 1h

let historyCache: { at: number; data: HistoryResponse } | null = null;

function quantile(sorted: number[], p: number): number {
	const n = sorted.length;
	if (n === 0) return 0;
	if (n === 1) return sorted[0];
	const pos = (n - 1) * p;
	const base = Math.floor(pos);
	const rest = pos - base;
	const lo = sorted[base];
	const hi = sorted[base + 1] ?? lo;
	return lo + rest * (hi - lo);
}

function daysBetween(a: string, b: string): number {
	return (new Date(b + 'T00:00:00Z').getTime() - new Date(a + 'T00:00:00Z').getTime()) / 86400000;
}

async function fetchHistory(): Promise<HistoryResponse> {
	const url = 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=sh515180,week,,,400,qfq';
	const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
	if (!res.ok) throw new Error(`历史行情请求失败: ${res.status}`);
	const data = (await res.json()) as {
		data?: { sh515180?: { qfqweek?: string[][]; week?: string[][] } };
	};
	const rows = data.data?.sh515180?.qfqweek ?? data.data?.sh515180?.week ?? [];
	if (!rows.length) throw new Error('历史行情无数据');

	// 腾讯周K格式: [日期, 开盘, 收盘, 最高, 最低, 成交量]
	const points = rows
		.filter((r) => r[0] >= START_DATE)
		.map((r) => ({ date: r[0], price: parseFloat(r[2]) }));

	if (points.length < 2) throw new Error('历史行情数据不足');

	const baseDate = points[0].date;
	const xs = points.map((p) => daysBetween(baseDate, p.date));
	const ys = points.map((p) => p.price);
	const n = points.length;

	const meanX = xs.reduce((a, b) => a + b, 0) / n;
	const meanY = ys.reduce((a, b) => a + b, 0) / n;
	let num = 0;
	let den = 0;
	for (let i = 0; i < n; i++) {
		num += (xs[i] - meanX) * (ys[i] - meanY);
		den += (xs[i] - meanX) ** 2;
	}
	const slope = den === 0 ? 0 : num / den;
	const intercept = meanY - slope * meanX;

	const residuals = points.map((p, i) => p.price - (intercept + slope * xs[i]));
	const sorted = [...residuals].sort((a, b) => a - b);
	const bands = {
		high95: round(quantile(sorted, 0.95)),
		low05: round(quantile(sorted, 0.05)),
		high99: round(quantile(sorted, 0.99)),
		low01: round(quantile(sorted, 0.01))
	};

	const history: HistoryPoint[] = points.map((p, i) => {
		const trend = intercept + slope * xs[i];
		return {
			date: p.date,
			price: p.price,
			trend: round(trend),
			high95: round(trend + bands.high95),
			low05: round(trend + bands.low05),
			high99: round(trend + bands.high99),
			low01: round(trend + bands.low01)
		};
	});

	return {
		baseDate,
		intercept: round(intercept),
		slope: round(slope, 6),
		bands,
		history
	};
}

export async function getHistory(): Promise<HistoryResponse> {
	if (historyCache && Date.now() - historyCache.at < HISTORY_TTL) return historyCache.data;
	const data = await fetchHistory();
	historyCache = { at: Date.now(), data };
	return data;
}

export async function getQuote(): Promise<Quote> {
	// 新浪
	try {
		const res = await fetch('https://hq.sinajs.cn/list=sh515180', {
			headers: { Referer: 'https://finance.sina.com.cn', 'User-Agent': 'Mozilla/5.0' }
		});
		if (res.ok) {
			const text = new TextDecoder('gbk').decode(await res.arrayBuffer());
			const m = text.match(/hq_str_sh515180="([^"]*)"/);
			if (m) {
				const p = m[1].split(',');
				if (p.length > 31) {
					const price = parseFloat(p[3]);
					const open = parseFloat(p[1]);
					const high = parseFloat(p[4]);
					const low = parseFloat(p[5]);
					if (price > 0) {
						return {
							price,
							open,
							high,
							low,
							name: p[0],
							source: '新浪',
							time: `${p[30]} ${p[31]}`
						};
					}
				}
			}
		}
	} catch {
		// 继续尝试腾讯
	}

	// 腾讯
	const res = await fetch('https://qt.gtimg.cn/q=sh515180', {
		headers: { 'User-Agent': 'Mozilla/5.0' }
	});
	if (!res.ok) throw new Error(`行情请求失败: ${res.status}`);
	const text = new TextDecoder('gbk').decode(await res.arrayBuffer());
	const m = text.match(/v_sh515180="([^"]*)"/);
	if (!m) throw new Error('行情解析失败');
	const p = m[1].split('~');
	const price = parseFloat(p[3]);
	const open = parseFloat(p[5]);
	const high = parseFloat(p[33]);
	const low = parseFloat(p[34]);
	if (!(price > 0)) throw new Error('行情数据无效');
	return { price, open, high, low, name: p[1], source: '腾讯', time: new Date().toLocaleString() };
}
