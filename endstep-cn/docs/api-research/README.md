# 数据来源调研总览

本目录留档用户脚本所依赖的**外部数据来源**与实测结论，便于日后维护、排错与扩充。

> 这些文件**不参与运行**，仅是调研记录；脚本本身为单文件自包含。

| 子目录 | 来源 | 在脚本中的角色 |
|---|---|---|
| [`mtgch/`](mtgch/README.md) | 大学院废墟 <https://mtgch.com> 公开 API | **中文卡名 / 类别 / 规则文本 / 关键词 / 中文卡图**的唯一来源 |
| [`scryfall/`](scryfall/README.md) | Scryfall <https://scryfall.com> / `cards.scryfall.io` | 卡图 CDN 与**英文回退**信息；页面 URL 中的卡牌 UUID 亦为 Scryfall 标识 |
| [`endstep-frontend/`](endstep-frontend/README.md) | `endstep.cc` 的公开静态资源 | 用于判断站点技术栈与卡图链路，确定识别策略 |

## 与脚本的对应关系

| 脚本行为 | 依据 |
|---|---|
| 按 UUID / 系列+编号 / 英文名三级识别卡牌 | 三个来源的存储形式不同：端步页面只给代理卡图 URL，Scryfall 提供 UUID 语义，mtgch 提供中文 |
| 中文取值优先级 `atomic_translated_*` → `zhs_*` → `printed_*` | [mtgch 文档第 5 节](mtgch/README.md) |
| 名称路径必须「二次核对」 | [mtgch 文档第 6 节第 1 条](mtgch/README.md)：实测首条搜索结果常非目标卡 |
| 请求串行限速 220ms、去重、30 天缓存、失败回退英文 | 三个来源共同的使用条款要求，详见各自文档的「合规」一节 |

## 合规总则

- 只使用**公开只读**端点，不绕过鉴权（不使用 mtgch 需 JWT 的 `tools/translate/*`）。
- 低频率访问、必须缓存；**禁止批量抓取整库**，禁止用于搭建镜像或克隆服务。
- 浮窗标注中文来源；社区译文不代表官方；缺失时显示英文。
- 前端静态资源仅用于**兼容性判断**，不得据此枚举站点私有接口。

## 采样时间

样本抓取于 2026-09（见各文件内的时间戳/`updated_at` 字段）。
