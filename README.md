# 大肥鱼记忆不止7秒

> DSH（DeepSeek Harness）的本地长期记忆插件。
> 名字是个玩笑，但设计不是：**记忆能不能被信任，比能记多少更重要。**

大部分记忆插件只做两件事：向量化、塞进上下文。用久了会踩到两个坑：

| 坑 | 本插件的做法 |
|---|---|
| 分不清「用户说的」和「模型推的」，久了记忆互相污染 | 每条记忆强制带**可信度**（`basis`）：`direct_report` = 用户原话，`derived_summary` = 模型总结，注入时显式标注 |
| 记忆过期了还在生效，甚至和 skill 打架 | `claim_state` + `temporal` 管生死；**流程类记忆不参与自动注入**，skill 永远是权威 |

## 它做什么

- **自动记**：每轮对话把用户与助手的原文落库，规则抽取成一条条可验证的陈述
- **自动想**：每轮开始前，按当前问题召回相关记忆，精排后注入上下文
- **可追溯**：每条记忆都有出处（哪次对话、哪句原话），不是黑盒
- **可纠正**：你说「删掉那条」「改成这样」，它才动——工具会核对你的最新消息
- **看得见**：自带只读看板，记忆不是玄学

## 关键：你需要自己的 API key

**这个仓库不包含任何密钥。** 你需要一个能提供下面两种模型的 API —— 任何兼容 OpenAI 接口的服务都可以：

| 用途 | 推荐模型 | 说明 |
|---|---|---|
| 向量化 | `BAAI/bge-m3`（1024 维） | 中文效果好、多语言，多数平台都有免费额度 |
| 重排 | `BAAI/bge-reranker-v2-m3` | 把「像」变成「对」 |

## 安装

**方式一：从 GitHub 直装（推荐）**

```bash
dsh plugin --profile web add github:fandy20262026-eng/dafa-fish-memory#v1.0.0
```

末尾的 `#v1.0.0` 是版本锚点，保证装到固定版本、不会哪天被上游改动影响。
想始终跟随最新代码，去掉 `#v1.0.0` 即可。

**方式二：克隆后本地安装**

```bash
git clone https://github.com/fandy20262026-eng/dafa-fish-memory.git
dsh plugin --profile web add link:<克隆下来的目录绝对路径>
```

适合要改代码、或想先看源码再装的人。

**方式三：等它上 npm 之后**

```bash
dsh plugin --profile web add dafa-fish-memory
```

装完**重启 dsh**。浏览器端记得 `Ctrl+Shift+R` 硬刷新一次。

## 配置

最小配置只需要一个 key。二选一：

**方式 A：环境变量**（推荐，key 不落盘）

```powershell
# Windows：设一次，之后所有会话都能读到
setx MEMORY_API_KEY "sk-你的密钥"
```

**方式 B：写进插件配置**（在 profile 的 `cordis.patch.yml` 里）

```yaml
- id: dafa-fish-memory
  name: dafa-fish-memory
  config:
    apiKey: ${MEMORY_API_KEY}   # 插件会自己展开 ${...}
```

插件支持 `${环境变量名}` 语法，也会直接读 `process.env.MEMORY_API_KEY`。
（更名前的旧变量名仍然兼容，老配置不用改。）
**如果 key 没配好，插件不会崩，而是降级为「只存不搜」**，`memory_doctor` 会告诉你要修什么。

常用配置：

| 配置项 | 默认值 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `isolation` | `workspace` | `workspace` 按工作区隔离；`global` 跨工作区共享（只改读的范围，不改已有数据） |
| `embeddingModel` / `embeddingDim` | `BAAI/bge-m3` / `1024` | 向量模型。`Pro/` 开头会被拒绝 |
| `rerankModel` | `BAAI/bge-reranker-v2-m3` | 重排模型 |
| `autoRecall` | `true` | 每轮自动召回并注入 |
| `autoCapture` | `true` | 自动采集对话 |
| `extraction` | `rules` | `rules` 规则抽取（快）；`llm` 用模型挑选（更准但慢，需配 `extractionModel`） |
| `recallTimeoutMs` | `5000` | 召回硬超时，超时这轮就不注入 |
| `maxItems` / `contextMaxChars` | `5` / `4000` | 注入预算 |
| `scaleTier` | `auto` | 记忆规模档位，`auto` 自动判断；可强制 `A`/`B`/`C` |
| `viewerEnabled` / `viewerPort` | `true` / `18181` | 只读看板 |
| `storagePath` | `$DSH_HOME/memory-sf/memory.db` | 数据文件位置 |

## 记忆多了会不会变慢

会自动分档，**不需要你配置**：

| 档位 | 规模 | 存储 | 策略 | 实测扫描耗时 |
|---|---|---|---|---|
| **A** | ≤ 2 万条 | float32 | 全量扫描 | 约 70 ms |
| **B** | 2 万–10 万 | float32 | SQL 预筛（重要度 ≥0.4 或近 180 天）后扫描 | 约 140 ms（预筛到 4 万） |
| **C** | > 10 万 | int8 | 预筛 + 量化，内存压到 1/4 | 约 160 ms |

实测数据来自 `npm run scale-bench`，你可以自己跑。

几个反直觉的结论，写在这里省得别人再踩：

- **int8 量化并不会提速**。V8 对 `Int8Array` 没有向量化，整数乘加和 float 差不多快。它唯一的收益是**内存降到 1/4**，所以只在大库（C 档）用来控内存。
- **真正压住延迟的是预筛**，也就是「减少参与比较的条数」，而不是换存储格式。
- 真实召回里，扫描只占小头，大头是两次网络调用（查询嵌入约 200ms + rerank 约 300ms）。

## 工具

| 工具 | 作用 |
|---|---|
| `memory_search` | 检索记忆，返回带可信度与出处的条目 |
| `memory_write` | 显式保存一条记忆 |
| `memory_forget` | 删除或纠正一条（**会核对你的最新消息，不是想删就删**） |
| `memory_stats` | 规模与构成 |
| `memory_doctor` | 自检三态：`ok` / `attention` / `degraded` |

## 看板

启动后访问 `http://127.0.0.1:18181`：列表、搜索、按作用域筛选、看每条记忆的可信度与来源。

**只读**——删除和纠正只能通过对话里的工具完成，避免绕过「用户明确要求」的校验。

## 隐私与数据

- **全部数据在本地** `$DSH_HOME/memory-sf/`，不上传任何服务器
- 唯一的外发是：**当前查询**和**候选记忆的文本**会发给 embedding / rerank 接口（这是向量化必须的）
- 不想外发可以设 `privacy: 'no-rerank'` 完全离线（只靠本地关键词 + 已有向量）
- 采集内容：只要用户与助手的文本。**不采集工具输出、模型推理、子 agent 会话**

## 从 memos 迁移

如果你以前用 `@memtensor/memos-local-plugin`，可以导入它的历史：

```bash
node scripts/import-memos.js --source <memos.db 路径>
```

- 来源库**只读**打开，不改它
- 导入内容一律标为 `derived_summary`（因为那些是它的总结，不是你的原话）
- 按来源去重，可以重复跑

## 排障

| 现象 | 先看 |
|---|---|
| 记忆一直是空的 | `memory_doctor`：key 有没有配对、`probe=true` 是否返回 200 |
| 注入没生效 | `memory_doctor` 里「本次运行：注入 N 次」；召回超时会记日志 |
| 想看模型到底看见了什么 | `$DSH_HOME/memory-sf/diag.jsonl`，每次召回都有一行 |
| 多端重复跑嵌入 | 看 `memory-sf/worker.lock` 的持有者，正常只有一个 |

## 设计取舍

- **只从用户原话抽取记忆**：助手说的是二手信息，存原文但不直接成为记忆
- **钩子里绝不抛错**：召回超时、接口失败、数据库异常，一律退化为「这轮没有记忆」
- **记忆是数据不是指令**：注入带 `[UNTRUSTED DATA]` 边界，并转义伪造的闭合标签
- **与 skill 冲突时以 skill 为准**：记忆只补充事实，不提供流程

## License

MIT
