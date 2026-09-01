import { json } from '@sveltejs/kit';
import { getQuote } from '$lib/server/stock';

export async function GET() {
	try {
		return json(await getQuote());
	} catch (e) {
		const message = e instanceof Error ? e.message : '获取实时行情失败';
		return json({ error: message }, { status: 502 });
	}
}
