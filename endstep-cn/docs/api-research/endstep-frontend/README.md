# Endstep 前端静态资源调研

本目录留档 `endstep.cc` 的**公开静态资源**快照，仅用于判断站点技术栈与卡图链路，以确定用户脚本的识别策略。

> 脚本不读取这些文件；本目录只作调研记录。
> **重要**：请勿用这些文件去枚举或调用站点私有接口、或仿制服务——调研目的仅为页面兼容性判断。

---

## 1. 结论（决定识别策略）

| 观察 | 结论 |
|---|---|
| 首页 HTML 只有 `<div id="root"></div>` + `/assets/main-*.js` | **客户端渲染的 SPA**（Vite + React），所有路由共用同一外壳 |
| 含 `vite-plugin-pwa`、`/registerSW.js`、`/manifest.webmanifest` | 站点是 PWA，并注册了 Service Worker |
| 含 `window.__CF$cv$params` 与 `/cdn-cgi/challenge-platform/...` | 前置 **Cloudflare**（可能有挑战/机器人管理） |
| `<link rel="preconnect" href="https://cards.scryfall.io">` | 卡图最终来自 **Scryfall CDN** |
| HTML 注释：`every <img> asks our own origin first (/api/cards/image 302s to it)` | 卡图是 `<img src="/api/cards/image...">`，**先打自己的源再 302 跳转** |

**因此**：

- `view-source`（含 Chrome 的「查看源代码」另存）**看不到卡牌 DOM**——它是客户端渲染的；要取 DOM 必须在 F12 → Elements 里看渲染后的结果（这也是我此前判断这些快照无助于定位识别规则的原因：11 个页面快照全为 29.5 KB 外壳、`<img>` 数为 0）。
- 卡图的 **Scryfall UUID 通常不在 DOM 里**（它只出现在 302 的响应头中），所以脚本的识别依赖：`alt` 文本 → 代理 URL 的查询参数 → 卡牌容器（向上 3 层）内的名称文本。

## 2. 样本文件

| 文件 | 内容 | 说明 |
|---|---|---|
| `endstep-home.html` | 首页外壳源码 | 可确认 meta/PWA/preconnect 等 |
| `endstep-main.js` | Vite 打包的主 JS（约 1.4 MB） | 仅作技术栈判断；**不做接口枚举** |
| `endstep-main.css` | 主样式表（约 380 KB） | 可核对类名与主题变量 |

抓取方式（示例）：

```bash
curl -s https://endstep.cc/ -o endstep-home.html
# 资源路径取自 HTML 里的 /assets/main-*.js 与 /assets/main-*.css（构建哈希会变化）
```

## 3. 相关结论的落地位置

「卡图是代理地址、UUID 不在 DOM」这一事实，直接对应脚本中的两处设计：

- 识别优先级第 3、4 步：祖先容器 `data-*` / URL 查询参数名称 / 容器内名称文本兜底；
- 名称查询必须二次核对（因为只能用文本名称作为键）。
