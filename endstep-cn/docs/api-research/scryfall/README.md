# Scryfall 调研（卡图 CDN 与英文回退）

Scryfall 在本项目中承担两个角色：

1. **卡图 CDN**：端步的卡图经 `/api/cards/image` 302 跳到 `cards.scryfall.io`；页面 URL 中的 36 位 UUID 就是 Scryfall 的卡牌 ID（脚本用它作为第一优先识别键）。
2. **英文回退信息**：中文缺失时显示英文原文，字段语义以 Scryfall 为准。

> 脚本**不直接请求 Scryfall API**（中文走 mtgch；UUID 来自页面 URL）。本目录样本用于确认字段语义与「中文印刷」字段的可用性，以及为将来的离线兜底卡库做准备。

---

## 1. 中文印刷字段（已实测可用）

Scryfall 的印刷版本对象包含本地化字段：

| 字段 | 含义 |
|---|---|
| `lang` | 印刷语言，简体中文为 `"zhs"` |
| `printed_name` | 该印刷语言的卡名 |
| `printed_text` | 该印刷语言的规则文本 |
| `printed_type_line` | 该印刷语言的类别行 |

实测（简体中文搜索）：

```bash
curl -s -H "Accept: application/json" \
  "https://api.scryfall.com/cards/search?q=lang%3Azhs+set%3Aiko&order=name&page=1"
```

返回结果中同时存在 `printed_name` / `printed_text` / `printed_type_line` 与 `"lang":"zhs"`（见样本 `scryfall-zhs-search.json`）。

## 2. Bulk Data 类型（用于离线兜底）

`GET https://api.scryfall.com/bulk-data` 返回以下数据集（见样本 `scryfall-bulk.json`）：

| 类型 | 说明 | 是否含中文 |
|---|---|---|
| `oracle_cards` | 每个 Oracle ID 一张（英文） | 否 |
| `unique_artwork` | 每种独特插画一张 | 否 |
| `default_cards` | 每个印刷一张，英文；仅当某卡只有单一语言时才用该印刷语言 | 基本否 |
| `all_cards` | **每种语言**的每个印刷 | **是（含 `zhs`）** |

若将来要做「离线兜底卡库」，应取 `all_cards`（体量大）或改用 MTGJSON 的 `foreignData`（按语言组织，体积更友好）。

## 3. 样本文件

| 文件 | 内容 | 抓取命令 |
|---|---|---|
| `scryfall-bulk.json` | `/bulk-data` 列表（各数据集名称、体积、更新时间） | `curl -s https://api.scryfall.com/bulk-data -o scryfall-bulk.json` |
| `scryfall-zhs-search.json` | `lang:zhs set:iko` 的搜索结果（约 933 KB，175 张） | `curl -s "https://api.scryfall.com/cards/search?q=lang%3Azhs+set%3Aiko&order=name&page=1" -o scryfall-zhs-search.json` |
| `scryfall-zh-sample.json` | `/cards/random?lang=zhs` 单卡样本 | `curl -s "https://api.scryfall.com/cards/random?lang=zhs" -o scryfall-zh-sample.json` |

> 注意：`/cards/random?lang=zhs` 在该语言无印刷时会回退返回英文卡（样本中 `lang` 为 `"en"`）——这与「按语言精确取印刷」是两回事。

## 4. 合规

- 遵守 Scryfall 使用条款：设置可识别 `User-Agent`、保持低频率、避免批量拉取。
- Bulk Data 用于离线构建时也应低频拉取并本地缓存。
- 卡图版权归威世智，仅用于展示对照。
