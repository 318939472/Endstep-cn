# endstep-cn — Endstep 简体中文卡牌浮窗与界面汉化

为 [Endstep](https://endstep.cc/)（万智牌浏览器对战客户端）提供两项中文支持：

- **卡牌浮窗**：鼠标悬停卡牌，显示中文卡名、中文类别、中文规则文本与关键词释义；
- **界面汉化**：把界面上的英文按钮、菜单、标签替换为简体中文，可一键完整还原。

脚本为**单文件、无外部数据依赖**（词表全部内嵌），只读页面 DOM，不接入站点私有接口。

```text
endstep-cn/
├─ README.md                        # 使用说明（本文件）
├─ probe/
│  └─ endstep-cn.user.js            # 用户脚本（当前版本 0.3.0，单文件自包含）
└─ docs/
   ├─ api-research/                 # 数据来源调研留档（不参与运行）
   │  ├─ README.md                  # 调研总览
   │  ├─ mtgch/                     # 大学院废墟公开 API —— 中文数据来源
   │  ├─ scryfall/                  # 卡图 CDN 与英文回退
   │  └─ endstep-frontend/          # 站点技术栈与卡图链路
   └─ glossary/                     # 词表副本（关键词 / 界面词条 / 动态模式）
```

> [`docs/api-research/`](docs/api-research/README.md:1) 是调研留档（抓取的样本 + 结论），脚本运行时不读取它们。

---

## 安装

1. 安装 [Violentmonkey](https://violentmonkey.github.io/)（推荐）或 Tampermonkey。
2. 打开 / 点击下面的安装链接，油猴会弹出安装页，点「安装」即可（**无需复制粘贴源码**）：

   👉 <https://raw.githubusercontent.com/318939472/Endstep-cn/main/endstep-cn/probe/endstep-cn.user.js>

   也可在油猴面板选择「从 URL 安装」（Utilities → Install from URL），填入上面这行地址。
3. 打开 `https://endstep.cc/`，进入对局或牌表页面。

> ⚠️ **务必用上面的 URL 安装**：脚本约 2900 行，手工复制粘贴极易被截断。元数据不全时脚本会在油猴里「已存在且已启用」却从不运行，页面毫无反应。
> 若确需自行引入，请确保首行 `// ==UserScript==`、头部含 `// @match https://endstep.cc/*` 与 5 条 `// @grant`、末行 `})();`。

该链接始终指向仓库 `main` 分支的最新版；脚本更新后重新打开上面的安装链接即可覆盖安装。

---

## 使用

### 卡牌浮窗

- **悬停卡牌**：跟随鼠标显示中文浮窗；中文缺失时显示英文原文并附提示。
- 双面牌按牌面分区块显示；`{R}`、`{2}` 等法术力符号由卡面 HTML 的 `sr-only` 文本自然还原，无需额外字体。
- 浮窗底部标注数据来源与版本信息。

### 界面汉化

- 默认开启。只处理三类文本：
  1. **整串精确匹配**：`Play` → `使用`、`Pass Priority` → `让过优先权`（支持尾随冒号与复数回退，如 `Settings:` → `设置：`、`Creatures` → `生物`）；
  2. **有限动态模式**：`Turn 5` → `回合 5`、`3 lives` → `3 生命`、`12x` → `12 张`；
  3. **全词可译的短组合**：`Move to Library` → `移动至牌库`。
- **不会**翻译：含中文的文本、超过 60 字的文本、以句末标点结尾的完整句子，以及任何含未知英文词的串（例如卡名 `Giant Growth`）。
- **跳过**：`script/style/code/pre`、表单控件内部文本、`contenteditable`、聊天与玩家名/牌组名区域、浮窗自身，以及带卡图的卡牌元素（保护卡名与 `alt`，避免破坏卡牌识别）。
- 界面重渲染（React）覆写文案后会自动重新应用；关闭开关时逐字还原。

### 插件菜单

| 菜单项 | 作用 |
|---|---|
| `☐/☑ 固定模式` | 固定浮窗（可拖拽顶部抓手移动）或跟随卡牌；位置会被记住 |
| `☐/☑ 界面汉化` | 开启/关闭界面汉化（关闭即还原原文） |
| `☐/☑ 调试模式` | 浮窗底部显示识别轨迹与汉化统计（如 `汉化: 开 · 已译 37 处`） |
| `⚙ 设置样式…` | 底色/边框/卡名/类别/正文/关键词的颜色与字号，带实时预览；含「汉化界面文本」开关 |
| `🧹 清空本地缓存` | 清空已缓存的卡牌中文数据 |

---

## 配置项

| 键 | 存储 | 说明 |
|---|---|---|
| `endstep-cn-settings` | GM 存储 | 样式与模式开关（由菜单与设置对话框维护） |
| `endstep-cn-card-cache-v1` | GM 存储 | 卡牌中文缓存，30 天过期，最多 600 条 |
| `endstep-cn-debug` | localStorage | 设为 `1` 打开调试模式（等同于菜单项） |
| `endstep-cn-glossary-url` | localStorage | 可选：指向外部关键词词库 JSON，加载后与内置词库合并 |
| `data-endstep-cn` | `<html>` 属性 | 运行标记：`loaded:` / `ready:` / `no-body:` / `error:` + 版本号 |

---

## 卡牌识别与数据来源

**识别顺序**（只读 DOM）：

1. **UUID**：从卡图地址或身份相关 `data-*` 属性中提取 Scryfall 卡牌 UUID（36 位），命中后按 ID 取中文；
2. **系列 + 编号**：从图片 URL 参数（`set` / `number` 等）或 `/card/SET/NUM` 路径提取；
3. **祖先兜底**：卡图所属容器（向上 3 层）的 `data-*`、URL 查询参数中的名称（`name` / `card` 等）、以及容器内的名称文本；
4. **文本名称（二次核对）**：取 `alt` / `title` / `aria-label` / 卡名文本，规范化后查询，并**核对完整名称或双面牌面名称**后才采用——绝不直接使用搜索结果第一条；
5. 以上均未命中中文时，回退显示英文原文。

> 端步的卡图是 `<img src="/api/cards/image...">`（先打自己的源，302 才跳到 Scryfall CDN），
> 因此 **Scryfall 的 UUID 通常不在 DOM 里**，只能来自 `alt`、代理 URL 的查询参数或卡牌砖块内的名称文本——第 3、4 步正是为此设计。

**数据来源**：

- 中文数据来自**大学院废墟公开 API**（`https://mtgch.com/api/v1`，文档 `https://mtgch.com/api/v1/docs`）；字段优先取 `atomic_translated_*` / `full_translated_name`，其次 `zhs_*` / `printed_*`；
- 英文回退信息取自 Scryfall。

**请求策略**：串行限速（最小间隔 220ms）、in-flight 去重、失败指数退避重试（4xx 不重试）、内存 + GM 双层缓存。

---

## 内置词表

三张表位于 [`probe/endstep-cn.user.js`](probe/endstep-cn.user.js:1) 顶部（脚本运行时只读这里的内嵌表）。
**推荐改为维护 JSON**：编辑 [`docs/glossary/`](docs/glossary/README.md:1) 下的两份 JSON，再运行写回工具，即可更新这三张表——不需要手工改脚本：

```bash
cd docs/glossary
node apply-to-userscript.mjs --dry-run   # 先看会改什么
node apply-to-userscript.mjs             # 写回脚本
node apply-to-userscript.mjs --check     # 校验脚本与 JSON 是否一致（有差异退出码 1）
```

| 表 | 规模 | 作用 |
|---|---|---|
| `BUILTIN_GLOSSARY` | 82 条 | 关键词释义（`First strike` → 先攻 + 说明） |
| `UI_TERMS` | 364 条 | 界面词条（整串 / 组合匹配） |
| `UI_PATTERNS` | 17 条 | 界面动态模式（正则 + 替换） |

---

## 排查：装上了却没有反应

**第 1 步：查运行标记（最可靠）。** 在页面控制台执行：

```js
document.documentElement.getAttribute('data-endstep-cn')
```

| 结果 | 含义 | 处理 |
|---|---|---|
| `ready:0.3.0` | 主脚本正常运行并完成安装 | 若仍无浮窗，看第 4 步 |
| `loaded:…` / `no-body:…` | 已运行但安装未完成 | 查看控制台是否有 `[Endstep CN] 初始化失败:` |
| `error:…` | 安装阶段抛错 | 冒号后即原因 |
| `null`（未设置） | **主脚本没有运行** | 走第 2 步 |

**第 2 步：标记为 `null` 时**，按可能性依次处理：

1. **安装不完整或未被识别**（最常见）：打开油猴面板中的该脚本，确认首行 `// ==UserScript==`、头部含 `// @match https://endstep.cc/*` 与 5 条 `// @grant`、末行 `})();`；有缺失就删除后，按[安装](#安装)章节的链接重新安装，不要手工复制源码。
2. 确认脚本在油猴里**已启用**；并留意脚本条目上是否有报错角标。
3. 确认当前地址被 `@match` 覆盖：本站 `endstep.cc` 与 `www.endstep.cc` 指向同一个应用，脚本已同时匹配两者；若使用其他域名（或带端口的内网/镜像地址），请自行追加一行 `@match`。
4. 控制台应出现 `[Endstep CN] 已加载 v0.3.0，当前页面：…`。

> ⚠️ **不要用 `window.EndstepCn` 判断脚本是否运行**：带 `@grant` 的脚本运行在油猴沙箱中，它的 `window` 不是页面 `window`，页面控制台看不到 `EndstepCn` 属正常现象。请以 `<html data-endstep-cn>` 标记与 `#endstep-cn-panel` 是否存在为准。

**第 3 步：确认开关。** 界面汉化默认开启；若曾关闭，在菜单里重新勾选 `☑ 界面汉化`。

**第 4 步：打开调试模式。** 菜单勾选 `☑ 调试模式`，悬停卡牌时浮窗底部会显示识别轨迹（元素、uuid、系列编号、名称候选、命中阶段）与 `汉化: 开 · 已译 N 处`，可直接看出卡在哪一步。

**第 5 步：识别不到卡牌时，采集真实 DOM。** 在 F12 → Elements 里选中一张卡图，查看它的 `src` / `alt` 与父级容器的 `class` / `data-*`，据此调整主脚本顶部的常量：`CARD_ZONE_PATTERN`、`IDENTITY_ATTR_PATTERN`、`extractSetCollector` 的参数名列表（`set` / `number` 等）、`extractQueryNameHints` 的名称参数列表（`name` / `card` 等）。

---

## 版本变更

| 版本 | 变更 |
|---|---|
| 0.3.0 | 新增 `<html data-endstep-cn>` 运行标记（跨油猴沙箱可验证）；README 排查章节改为以标记为准 |
| 0.2.0 | 补齐 `www.endstep.cc` 与 `*.endstep.cc` 匹配；卡牌识别增加祖先容器（3 层）与 URL 查询参数兜底；启动日志 |
| 0.1.0 | 首个版本：卡牌浮窗（大学院废墟中文 API + 二次核对）、界面汉化（364 条词条 + 17 条模式）、设置与菜单 |

---

## 已知限制

- **不做长句与自由文本翻译**：机翻长句会污染界面且难以还原，故规则提示、聊天内容等保持英文。
- **无法覆盖 Canvas / 图片内文字**：站点若用 Canvas 绘制文案，本方案不适用。
- **依赖第三方 API 可用性**：已做缓存与英文回退，但无法保证 100% 中文覆盖。
- **SPA 结构变化**：站点为 Vite + React 且类名经哈希，识别采用宽松多兜底；若改版导致某类卡牌不再识别，按排查第 5 步采集 DOM 后调整常量。
- **快捷键与操作不受影响**：浮窗为 `pointer-events:none`，不拦截点击、拖拽或键盘输入。

---

## 许可

脚本代码按 GPL-3.0 许可；关键词与界面词表为社区整理，仅供参考。
本项目与 Endstep、威世智（Wizards of the Coast）均无关联。Magic: The Gathering 是威世智的注册商标。
