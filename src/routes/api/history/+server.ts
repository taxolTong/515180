import { json } from '@sveltejs/kit';
import { getHistory } from '$lib/server/stock';

export async function GET() {
	try {
		return json(await getHistory());
	} catch (e) {
		const message = e instanceof Error ? e.message : '获取历史数据失败';
		return json({ error: message }, { status: 502 });
	}
}
