# 大学院废墟（mtgch.com）公开 API 调研

本目录记录用户脚本**简体中文卡牌数据**的来源与用法：由只读公开端点抓取的样本、OpenAPI 规范，以及据此确定的字段取值优先级与已知坑。

- 站点：<https://mtgch.com>
- Swagger UI：<https://mtgch.com/api/v1/docs>
- OpenAPI JSON：<https://mtgch.com/api/v1/openapi.json>（本地快照：`mtgch-openapi.json`，约 309 KB）

> 所有样本均为**匿名只读**抓取，未使用任何需要登录态的端点。

---

## 1. 脚本用到的端点（匿名可用）

| 方法 | 路径 | 用途 | 对应脚本实现 |
|---|---|---|---|
| GET | `/api/v1/card/{card_id}/` | 通过 UUID 取卡牌完整数据（主路径） | `fetchCardDetail` → `normalizeDetail` |
| GET | `/api/v1/card/{set}/{collector_number}/` | 通过「系列 + 编号」取卡（备用路径） | `fetchCardBySetCollector` |
| GET | `/api/v1/result?q=…` | 按英文名搜索（名称路径） | `resolveByName` → `normalizeSearchItem` |
| GET | `/api/v1/blog/get/{path}` | 取「博客/文章」内容；`path=cr/glossary` 即**官方《完整规则》术语表**（英文 → 官方简体中文） | 词表对齐（离线同步，脚本运行时不调用） |

确认存在但脚本未使用的公开端点：`/autocomplete/`、`/sets/`、`/set/{set_code}/cards/`、`/versions/{card_id}/`、`/random`、`/card/next`、`/card/prev`。

## 2. 脚本**不使用**的端点（需鉴权）

```
POST /api/v1/tools/translate/oracle
POST /api/v1/tools/translate/flavor
POST /api/v1/tools/translate/ruling
POST /api/v1/tools/translate/card-name
```

OpenAPI 中这些端点标注 `security: JWTAuth`（登录后才可用）。脚本一律不调用，避免绕过鉴权。

---

## 3. `/result` 查询参数（取自 OpenAPI）

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `q` | string | 是 | 查询字符串 |
| `page` | integer | 否 | 页码 |
| `page_size` | integer | 否 | 每页数量（默认 20） |
| `order` | — | 否 | 排序字段 |
| `unique` | — | 否 | 去重方式：`scryfall_id` / `oracle_id` / `illustration_id` |
| `priority_chinese` | boolean | 否 | 是否优先中文（去重选择版本时生效） |
| `view` | — | 否 | 视图类型：`0` 返回卡片详细信息；`1` 返回当前扩展展示的简化信息 |
| `include_fav` | boolean | 否 | 是否返回收藏信息 |

脚本实际使用：

```text
/api/v1/result?q=<英文名>&priority_chinese=true&unique=oracle_id&view=1&page_size=20
```

---

## 4. 两种响应形态

### 4.1 默认视图（`view=0` 或不传）：完整卡牌对象

字段与 Scryfall 对象基本一致，并附带中文与译名字段：

- 基础：`id`、`mtgjson_id`、`face_index`、`lang`、`oracle_id`、`layout`、`name`、`face_name`、`mana_cost`、`cmc`、`type_line`、`oracle_text`、`power`、`toughness`、`loyalty`、`defense`、`colors`、`color_identity`、`keywords`、`legalities`、`prices`、`rulings`、`all_parts`
- 印刷：`set`、`set_name`、`collector_number`、`rarity`、`released_at`、`artist`、`printed_name`、`printed_text`、`printed_type_line`、`image_uris`、`scryfall_uri`
- 中文（印刷级）：`zhs_name`、`zhs_type_line`、`zhs_text`、`zhs_flavor_text`、`zhs_language`、`zhs_image_uris`、`zhs_multiverse_id`、`zhs_extra`
- 译名（原子/整牌）：`atomic_official_name`、`atomic_translated_name`、`atomic_translated_type`、`atomic_translated_text`、`atomic_translated_flavor_name`、`atomic_translated_flavor_text`、`atomic_name_translated_from`、`atomic_text_translated_from`
- 拼合名：`full_official_name`、`full_translated_name`、`set_translated_name`、`former_names`
- 其他：`other_faces`、`keyrune_code`、`pinyin`、`pinyin_first_letter`、`is_preview`

### 4.2 中文优先展示视图（`view=1`）

字段与上面**完全不同**，是面向展示的精简结构（脚本名称路径使用它）：

| 字段 | 含义 |
|---|---|
| `id` / `oracle_id` | 卡牌 ID / 同名牌 ID |
| `display_name` / `display_name_zh` | 英文名 / 中文名 |
| `display_type_line` | 中文类别行（如 `瞬间`） |
| `oracle_text_html` | 中文规则文本 HTML（法术力符号写在 `sr-only` 里） |
| `mana_cost_html` | 法术力费用 HTML |
| `flavor_text_html` | 背景叙述 HTML |
| `power_toughness_loyalty_defense` | 力量/防御力等（如 `2/2`） |
| `image_url` | 中文卡图：`https://images.mtgch.com/zhs/normal/front/<uuid>.webp` |
| `art_crop` | 插画裁切图 |
| `card_detail_url` | 站内详情页路径（如 `/card/SOS/113/`） |
| `set` / `collector_number` / `rarity` / `keyrune_code` | 印刷信息 |
| `is_double_faced` / `other_faces[]` | 双面牌与其它牌面 |
| `display_flavor_name` / `display_flavor_name_zh` / `former_names` | 风味名 / 曾用名 |
| `color_indicator_html` / `is_favorited` / `favorite_count` / `is_preview` / `created_at` | 其他 |

---

## 5. 脚本的字段映射

| 脚本记录字段 | 取值优先级 |
|---|---|
| `name_zh` | `full_translated_name` → `atomic_translated_name` → `zhs_name` → `printed_name` → 英文 `name` |
| `type_zh` | `atomic_translated_type` → `zhs_type_line` → `printed_type_line` |
| `text_zh` | `atomic_translated_text` → `zhs_text` → `printed_text` |
| `name_en` | `full_official_name` → `name` |
| `mana_cost` | `mana_cost`（`view=1` 时由 `mana_cost_html` 去标签，保留 `{R}` 等符号） |
| `pt` | `power`/`toughness` → `loyalty` → `defense`（`view=1` 直接用 `power_toughness_loyalty_defense`） |
| `keywords` | `keywords`（英文，用于联动内置关键词词库） |
| `faces` | `other_faces[]`（双面牌分块渲染） |
| `image_zh` | `zhs_image_uris.normal`（`view=1`：`image_url`） |
| `image_en` | `image_uris.normal` |
| `set_zh` | `set_translated_name` → `set_name` |
| `hasZh` | `name_zh` / `type_zh` / `text_zh` 任一非空 |

---

## 6. 实测样本与已知坑（**必读**）

1. **绝不能取第一条搜索结果。**
   `q=Sol Ring` 返回 `[Sol Ring (MSC/211), Solemn Offering (BBD/107)]`；
   `q=Lightning Bolt` 首条是 `Emeritus of Conflict // Lightning Bolt`（其某一面的名称恰好是 Lightning Bolt）。
   → 因此脚本必须二次核对：**完整名 2 分、双面牌某一面名 1 分、不匹配 0 分**，取最高分且大于 0 者（见 `scoreSearchItem`）。
2. **中文要在搜索阶段就要求。** 加 `priority_chinese=true&unique=oracle_id&view=1` 后，实测 Lightning Bolt 得到中文名「闪电击」与中文规则文本、中文卡图。
3. **`zhs_image` 不是卡图。** 该字段看着像中文卡图，实测值却是**画师名**（例如 `"Trent Touch"`），属上游数据瑕疵；取中文卡图请用 `view=1` 的 `image_url` 或 `zhs_image_uris`。
4. **双面牌 / 拼合牌**：detail 中 `name` 可能是 `A // B`，而 `atomic_translated_name` 常只给正面，`full_translated_name` 才给 `A' // B'`；另一面信息在 `other_faces`。脚本用 `full_translated_name` 作标题，并按面拆块。
5. **正文换行**：`atomic_translated_text` 中可能出现字面量 `\n`（反斜杠 + n），脚本统一还原成真实换行。
6. **`view=1` 与默认视图不能混用**：字段集不同；且 `view=1` 不含 `keywords`，因此脚本在名称路径会**再取一次 detail** 以拿到关键词。
7. **必须限速 / 去重 / 缓存**：脚本串行请求（间隔 220ms）、in-flight 去重、内存 + GM 双层缓存（30 天，最多 600 条），失败时回退英文原文。

---

## 7. 样本文件清单

| 文件 | 内容 | 抓取命令 |
|---|---|---|
| `mtgch-openapi.json` | 完整 OpenAPI 规范（含全部端点与 schema） | `curl -s https://mtgch.com/api/v1/openapi.json -o mtgch-openapi.json` |
| `mtgch-docs.html` | Swagger UI 页面（仅壳，实际内容由 JS 加载） | `curl -s https://mtgch.com/api/v1/docs -o mtgch-docs.html` |
| `mtgch-solring.json` | `q=Sol Ring`（默认视图）——演示「首条并非目标卡」 | `curl -s "https://mtgch.com/api/v1/result?q=Sol%20Ring" -o mtgch-solring.json` |
| `mtgch-bolt.json` | `q=Lightning Bolt` + `priority_chinese&unique=oracle_id&view=1` ——中文优先展示视图 | `curl -s "https://mtgch.com/api/v1/result?q=Lightning%20Bolt&priority_chinese=true&unique=oracle_id&view=1" -o mtgch-bolt.json` |
| `mtgch-blossom.json` | `q=Blossoming Sands`（同上参数）——单结果示例 | 同上，替换 `q` |
| `mtgch-bolt-uuid.json` | `GET /card/f58dba4f-…/` ——detail，演示 `atomic_translated_*` / `zhs_*` / `keywords` | `curl -s "https://mtgch.com/api/v1/card/f58dba4f-1abb-47a3-a684-29c32bab95c0/" -o mtgch-bolt-uuid.json` |
| `mtgch-card-by-uuid.json` | `GET /card/91fdb56b-…/` ——detail，完整字段清单（Sol Ring） | `curl -s "https://mtgch.com/api/v1/card/91fdb56b-54d5-4272-8319-505ff987fe9b/" -o mtgch-card-by-uuid.json` |
| `mtgch-cr-glossary.json` | 官方术语表紧凑映射：`terms`（英文 → 官方中文，736 条） | `curl -s "https://mtgch.com/api/v1/blog/get/cr/glossary"`，取 `data.body_html` 解析出 `<h3>` 词条 |

> 终端若显示中文乱码，多为控制台代码页问题（内容本身是 UTF-8）；请用编辑器或 `read_file` 查看。

---

## 8. 合规与礼貌

- 只使用**公开只读**端点；不使用需要 JWT 的 `tools/translate/*`，不绕过任何鉴权。
- 保持低频率：脚本限速 + 30 天缓存；**禁止批量抓取整库**或用于搭建镜像服务。
- 浮窗必须标注来源「大学院废墟（mtgch.com）」；社区译文不代表官方。
- 数据缺失或请求失败时回退显示英文原文，不阻塞对局。

---

## 9. 复现方式

```bash
# 规范
curl -s https://mtgch.com/api/v1/openapi.json -o mtgch-openapi.json

# 按 UUID 取卡（中文译名字段在此）
curl -s "https://mtgch.com/api/v1/card/f58dba4f-1abb-47a3-a684-29c32bab95c0/"

# 按名称搜索（中文优先展示视图）
curl -s "https://mtgch.com/api/v1/result?q=Lightning%20Bolt&priority_chinese=true&unique=oracle_id&view=1"

# 按系列+编号取卡
curl -s "https://mtgch.com/api/v1/card/SOS/113/"
```

建议加上 `-H "Accept: application/json"` 与常规 `User-Agent`，并在两次请求之间留出间隔。
