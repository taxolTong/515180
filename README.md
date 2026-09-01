# 515180 中证红利ETF — 趋势通道交易系统

基于历史行情拟合线性趋势通道，计算今日五条关键价格（趋势值、95%/5% 高低估线、99%/1% 极端线），并据此给出实时买卖建议的看板。

由原 `demo.html` 迁移而来，改用 SvelteKit 实现，通过服务端代理解决第三方行情接口的跨域限制。

## 技术方案

- **框架**：SvelteKit + Svelte 5（runes 模式）+ TypeScript
- **图表**：[chart.js](https://www.chartjs.org/)
- **图标**：[lucide](https://lucide.dev/)（`@lucide/svelte`，替代原版 emoji）
- **样式**：组件内作用域 CSS，深色主题

## 跨域方案

第三方行情接口（新浪、腾讯）均有 CORS / Referer / GBK 编码限制，浏览器直接请求会被拦截。本项目在 SvelteKit 服务端提供代理路由，由服务端转发请求、解码 GBK 并返回 JSON，前端同源请求 `/api/*`，天然无跨域问题：

| 路由               | 作用                           | 上游接口                       |
| ------------------ | ------------------------------ | ------------------------------ |
| `GET /api/history` | 历史周K + 趋势通道模型         | 腾讯 `web.ifzq.gtimg.cn`       |
| `GET /api/quote`   | 实时行情（新浪优先，腾讯兜底） | `hq.sinajs.cn` / `qt.gtimg.cn` |

## 模型

历史数据取 2024-09-01 起的**前复权周K**，用最小二乘拟合线性趋势：

```
Trend(t) = intercept + slope × t   (t = 距基准日天数)
```

四条通道线由价格相对趋势的**残差分位数**确定（与趋势线平行）：

- 高估减仓线 (95%) / 低估加仓线 (5%)
- 极端高估线 (99%) / 极端低估线 (1%)

`intercept`、`slope` 与四条通道偏移量均随真实数据实时拟合，不再硬编码。

## 开发

```sh
pnpm install
pnpm dev          # 启动开发服务器
```

## 构建与检查

```sh
pnpm check        # svelte-check 类型检查
pnpm lint         # prettier + eslint
pnpm build        # 生产构建
pnpm preview      # 预览生产构建
```

> 部署到目标环境时，如需固定适配器，请按需在 `vite.config.ts` 中替换 `@sveltejs/adapter-auto`。

## 目录结构

```
src/
├── app.html                  # HTML 骨架（zh-CN）
├── routes/
│   ├── +page.svelte          # 主看板
│   ├── api/
│   │   ├── history/+server.ts # 历史数据代理
│   │   └── quote/+server.ts   # 实时行情代理
└── lib/
    ├── model.ts              # 趋势通道计算（回归、分位数、区间判断）
    ├── types.ts              # 共享类型
    └── server/stock.ts       # 行情抓取 + 模型拟合
```
