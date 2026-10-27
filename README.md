# dsh-companion-memory

陪伴 AI 的**冷热分层记忆** DSH 插件：全自动对话归档、旧事渐进冷存、按用户线索从冷库召回，
并在每轮请求发出前用一个**有预算上限的记忆快照**替换掉"每次都重读全部旧对话"。

设计思路来自公开方案
[`Companion-AI-Memory-Context-Token-Optimization`](https://github.com/ARCHEON999/Companion-AI-Memory-Context-Token-Optimization)。
本插件是**独立实现**：代码与提示词均为自行编写，未复制上游文本或代码。
上游仓库未声明 LICENSE，再分发时请保留本说明并自行评估。

## 它做什么

| 机制 | 实现 |
| --- | --- |
| 全自动归档 | 订阅 `session/event` 提交后事件流，每轮用户与助手原文追加进 `archive.jsonl` |
| 冷热分层 | `pinned` / `hot` / `cold` 三层，`tier` 只决定调用位置，原文归档不动 |
| 热度公式 | `heat = 0.45*F + 0.35*R + 0.20*O`，F 为去重且每日封顶的有效提及频率 |
| 渐进冷却 | 细节(≤72h) → 摘要(≥24h 可用后) → 冷库(候选宽限期 7 天 + 热度 <0.30 或 14 天未提及) |
| 线索召回 | 仅用户线索可开闸；`0.80*S + 0.20*C` 排序，**不惩罚年代**，强精确匹配优先 |
| 预算约束 | 快照 1600 tokens = 固定 160 / 活跃 960 / 召回 480，互不借用 |

## 工具

- `memory_remember` — 写入/更新一条记忆卡（带来源片段、主题、维度索引）。
- `memory_recall` — 按用户线索检索冷库，返回 `matched` / `ambiguous` / `not_found`，
  候选与正文共用 ≤3 条、≤480 tokens。
- `memory_forget` — `delete`（连归档副本一起清）、`supersede`（更正并保留旧版本）、
  `recall_only`（问到再说）、`unpin`、`allow_normal`。
- `memory_continuity` — 写入基础人格与当前相处状态；`reset: true` 在用户明确要求时清空两者。
- `memory_archive` — `stats` 归档量与会话分布、`backfill` 从会话日志回填历史轮次、
  `purge` 清理本插件归档副本（按会话 / 按时间 / 全部，需用户明确依据）。
- `memory_status` — 各层条目数、Top 热度、预算余量、最近一次冷却结果。

删除与更正会**立即**让已授权的召回副本失效，不需要等 30 分钟许可到期。

## 全自动对话归档怎么工作

- 订阅 `session/event`（post-commit 的追加事件流），只取 `user/message` 与 `assistant/message`；
  工具结果、系统消息与推理**不入档**。
- 正文优先用 Session 自带的 `deriveEventMessage(event)` 还原，失败时退回事件 `data`，
  并以 `content` / `blocks` / `parts` 三种命名的容错方式读取文本块。
- **业务上下文会被标记**：harness 把运行时上下文、时间戳与注入块也作为 user 消息写进日志。
  这些条目标记为 `system_context: true`，可与用户真实发言区分（实测在历史日志中约占 user 消息的 1/3）。
- `turn` / `step` 由 `turn/start`、`step/start` 事件推进的游标补齐，用户消息也能正确归属轮次。
- 水印按 `(session_id, seq)` 记录，**写入成功后才推进**，所以同一条不会重复入档；
  进程异常退出漏掉的轮次可以用 `memory_archive` 的 `backfill` 幂等补回。
- 回填通过 `ctx.sessionQuery` 读取历史会话日志；首次建议手动执行一次 `backfill`。

## 注入

每轮把**连续性状态 + 固定事实 + 相关活跃记忆**作为一个动态上下文块注入，
整体受 1600 tokens 约束；冷库正文不注入，只在用户给出线索时由工具取回。

## 数据位置

默认 `$DSH_HOME/companion-memory/`：

```
records.json   记忆卡
state.json     连续性状态、计数器、归档水印
archive.jsonl  原文归档（追加写）
```

## 装到别人的"鱼鱼"上

1. 把这个 `dsh-companion-memory/` 目录给对方（打包、发布 npm 或收进插件市场都可以）；
2. 对方用 `plugin_manager` 的 `install_bundle`，target 指向该目录或包名；
3. 新 bundle 会通过 HMR 直接激活，**不用重启**；
4. 建议的上手顺序：`memory_archive` 的 `backfill` 回填历史 → `memory_continuity` 写入自己的
   基础人格与当前相处状态 → 之后正常聊天即可。

**分发时必须注意**：

- 插件目录里的 `archive.jsonl` / `records.json` / `state.json` 是你**自己的私密记忆**，
  不要把 `$DSH_HOME/companion-memory/` 一起打包发出去。插件是代码，记忆是隐私。
- 本插件是 DSH 专用：依赖 `ctx.tools` / `ctx.systemPrompt` / `session/event` / `ctx.sessionQuery`。
- 代码与提示词为 MIT（见 `LICENSE`）；设计思路出处见本文件开头的说明。

## 已知边界（诚实说明）

- **归档是 fire-and-forget**：观察者失败不会让会话提交失败（好事），但进程异常退出可能漏记一轮；
  用 `backfill` 可幂等补回。
- **删除只覆盖本插件副本**：`archive.jsonl` 里的条目可以按你的要求清掉，
  但 DSH 自己的会话日志由 harness 的保留策略管理，本插件无法删除，也不应声称已删除。
- **回填默认关闭**（`backfillOnStart: false`）：首次回填会一次性写入大量历史，建议手动执行。
- **无向量模型**：`S`（语义相似度）由**词法相似度**在本地替代，
  属于方案里的 `fallback` 降级模式（禁止混用不同空间的分数）。
  配置了 embedding 模型后才应切回 `0.65*S + ...` 的真实向量排序。
- **热度权重未经真实对话校准**：上游明确说明这是工程初值，不是心理学规律。
- `token_counter_mode` 为 `estimated`：中文按 1 字≈1 token、拉丁字符 ≈4 字符 1 token
  估算并留有余量，不是硬保证。
- `system_context` 标记是**启发式**（按已知的注入标题前缀匹配），已随条目写入归档，
  方便后续核对与改进。