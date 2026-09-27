# 词表：JSON 为源，脚本为产物

本目录的两个 JSON 是**可编辑的源文件**。改完 JSON 后运行写回工具，用户脚本里内嵌的词表就会被更新——**不需要手工修改脚本**。

| 文件 | 内容 |
|---|---|
| `keyword-glossary.zh-CN.json` | 关键词释义（`name_zh` + `desc_zh`），浮窗「关键词」区块 |
| `ui-glossary.zh-CN.json` | 界面汉化词条（`terms`）+ 动态模式（`patterns`） |
| `apply-to-userscript.mjs` | **JSON → 脚本**：写回内嵌词表 |
| `extract-from-userscript.mjs` | 脚本 → JSON：从脚本反向导出（初次建立或核对时用） |

被写入的目标： [`probe/endstep-cn.user.js`](../../probe/endstep-cn.user.js:1) 顶部的三张表
`BUILTIN_GLOSSARY` / `UI_TERMS` / `UI_PATTERNS`。

---

## 推荐工作流

```bash
cd docs/glossary

# 1) 改 JSON（任意编辑器）
# 2) 先看会改什么（不写文件）
node apply-to-userscript.mjs --dry-run
# 3) 写回脚本
node apply-to-userscript.mjs
# 4) 校验脚本语法没被破坏
node --check ../../probe/endstep-cn.user.js
# 5) 在油猴里重新粘贴/更新脚本内容，刷新页面
```

提交前可用一致性校验（有差异时退出码为 1）：

```bash
node apply-to-userscript.mjs --check
```

## 写回工具的行为

- **行级 upsert**：只改动受影响的词条行，**保留脚本中的注释与分组顺序**，diff 最小、易审阅。
- JSON 里**新增**的键 → 追加到该区块末尾（闭合行之前）。
- JSON 里**删除**的键 → 从脚本中移除该行。
- 逐条校验字段类型（关键词须有 `name_zh` 与 `desc_zh`；界面词条的值须为字符串；模式须有 `replace`），**格式非法即报错退出**，不会写出半成品。
- 三张表来自两个 JSON：`keyword-glossary…` 对应 `BUILTIN_GLOSSARY`；`ui-glossary…` 的 `terms` / `patterns` 分别对应 `UI_TERMS` / `UI_PATTERNS`。

> 反向工具 `extract-from-userscript.mjs` 会**按脚本当前内容重写**这两个 JSON（含 `_extracted_at`）。
> 只有在你确认要以脚本为准时再运行它，否则会覆盖你对 JSON 的编辑。

## 词条写法约定

- `terms` 的键是**小写英文原文**，值为中文；多词短语按**整串**添加（如 `create game`、`pass priority`）。
- `the` / `a` / `an` 的值是**空串**，用于「组合匹配」时吞掉冠词（如 `Move to Library` → `移动至牌库`）。
- `patterns` 为 `{ pattern, flags, replace }`；`replace` 支持 `$1`。JSON 中正则需**双反斜杠**（如 `"^(\\d+)\\s*lives?$"`），写回脚本时会自动转成源文件里的 `\\d` 形式。
- 脚本的匹配顺序与安全边界（实现见脚本内 `translateUiText`）：
  1. 整串精确匹配（支持尾随冒号与复数回退）；
  2. 动态模式；
  3. 「每个英文词都能查到译名」的短组合；
  4. 以下一律**不改动**：含中文、超过 60 字、以句末标点结尾的完整句子、含未知英文词的串。

## 关键词的运行时热更新（可选）

除写回脚本外，关键词词表还有一条**无需改脚本**的通道：把 localStorage 的
`endstep-cn-glossary-url` 指向一份与 `keyword-glossary.zh-CN.json` 同结构的 JSON 的托管地址，
脚本会在启动时加载并与内置词表**合并**（同名键以外部为准）。

适合小范围试译；正式发布仍建议走「改 JSON → 写回脚本」，这样离线也有中文。

## 与官方术语表对齐（大学院废墟）

大学院废墟的《万智牌完整规则》术语表由**公开只读端点**提供，无需登录：

```bash
curl -s "https://mtgch.com/api/v1/blog/get/cr/glossary" -o cr-glossary.json
```

返回 `{page_type, data}`；`data.body_html` 是 240 KB 左右的 HTML，内含 700+ 条形如
`<h3><span id='英文'>英文</span> / <span id='中文'>中文</span></h3>` 的词条，即「英文术语 → 官方简体中文」。
本项目据此对齐（离线同步一次，脚本运行时不调用该端点）：

- **关键词词表** → `BUILTIN_GLOSSARY`：英文键命中官方时，`name_zh` 一律改为官方译名，
  并同步替换该条 `desc_zh` 内出现的旧称。官方用于消歧的**尾部括注会被去掉**（如「循环（异能）」→「循环」）。
- **界面词表** → `UI_TERMS`：仅对**规则类**词条采用官方译名；若旧译出现在其它词条的值中（改会造成前后不一致）则保持不变。
- 抓取留档：[`mtgch-cr-glossary.json`](../api-research/mtgch/mtgch-cr-glossary.json:1)（英文 → 官方中文的紧凑映射，含 `_endpoint` 与 `_fetched_at`）。

> 官方术语表面向**规则文本**，不要直接套用到界面按钮、菜单等非规则措辞上。

## 维护建议

- 优先添加**整串**词条（覆盖按钮/标签）；只有确认安全时才加入会参与「逐词组合」的通用词，避免误译。
- `Hand`、`Deck` 之类的区域词会同时被识别逻辑用于过滤，可放心留在词表中。
- 关键词释义保持一句话、句号结尾，浮窗按 `· 名称：说明` 逐行展示。
