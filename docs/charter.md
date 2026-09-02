# agy-proxy 立项文档

版本：草案 v0.1（2026-08-30）· 状态：待评审

> 本文档基于 2026-08-30 完成的四项调查（agy CLI 官方事实、先例项目、dsh-agy-link 代码可移植性、双协议最新规格）与技术选型核实。所有外部事实标注了出处；无法核实的项标注 UNVERIFIED。

## 1. 项目定位

agy-proxy 是自托管的 LLM 网关：把 Google Antigravity 官方 `agy` CLI 作为上游引擎，以 Docker 容器运行在 VPS 上，对外提供 **OpenAI Chat Completions** 与 **Anthropic Messages** 两种协议的 HTTP API（URL + API key 鉴权），并附带管理 WebUI。前置 nginx/Caddy 反代即可对外服务。

**核心路线（与 CLIProxyAPI 等先例的差异）**：只 spawn 官方未修改的 `agy` 二进制（`agy -p --output-format stream-json`），不做逆向 HTTP、不把 OAuth token 导入任何非 Google 客户端——这是条款风险最低的路线（等同于在终端里使用 agy）。Antigravity 条款第 6 条明确点名禁止的是"用第三方工具以 Antigravity OAuth 接入服务"（如 OpenClaw）。

**空白位**：截至 2026-08-30，没有任何项目同时具备 Antigravity 上游 + one-api/new-api 式按 key 多用户配额管理。CLIProxyAPI（49k★）只有静态 api-keys 列表、无按 key 记账。

## 2. 目标与非目标

**目标**
- 双协议端点最新格式完整支持（矩阵见 §4），流式 + 非流式
- 多账号池：隔离 HOME 沙箱、顺序消耗调度、家庭级配额冷却、429 自动切换
- API key 生命周期：创建/禁用/删除、每 key 用量与限额记账（SQLite）
- 受控工具执行：OpenAI tool_calls / Anthropic tool_use 完整往返（见 §4.2）
- WebUI：中文优先（EN 可切换）、仪表盘/账号/密钥/日志/设置
- 单容器 Docker 部署，持久卷，反向代理友好（SSE 心跳、trusted proxy）
- 稳定性优先：真实错误透传、账号健康度、优雅降级、崩溃可恢复

**非目标（v1）**
- 不做计费/支付（只做限额记账）
- 不做多上游（Codex/Claude Code 等其他 CLI）——架构预留，v1 只做 agy
- 不做公开多租户 SaaS；定位自用/小圈子
- 不支持音频输入输出、web_search、moderation 等无法映射到 agy 的参数（矩阵标"不支持"并返回明确 4xx，不静默丢弃）

## 3. 系统架构

```
浏览器 ──HTTPS── 反代(nginx/Caddy)
                    │
            ┌───────┴────────────────────────┐
            │ agy-proxy (Node 24 LTS, TS ESM)│
            │                                │
            │ /v1/chat/completions ─┐        │
            │ /v1/messages ─────────┼→ 协议适配层 → 统一内部 IR (StreamChunk)
            │ /v1/models (两种风格)  │        │      ↓
            │ /v1/messages/count_tokens     │ 引擎层（移植自 dsh-agy-link）
            │ /admin/* + 静态 WebUI  │   parser→recording→mapper→engine
            │                       │   pool/quota/oauth/net/media
            │ API-key 鉴权中间件     │      ↓ spawn（每账号串行队列）
            │ SQLite: keys/usage/logs│   agy -p --output-format stream-json
            └───────────────────────┘   （隔离 HOME 沙箱 per 账号）
```

**分层**
- **协议适配层（新写）**：`openai-adapter.ts` / `anthropic-adapter.ts`。请求方向：两种协议 → 内部 `GenerateOptions`；响应方向：内部 `StreamChunk` 流 → OpenAI SSE chunk（+`[DONE]`）或 Anthropic 事件序列（message_start/…）。所有字段映射集中在这一层，引擎层不感知协议。
- **引擎层（移植）**：parser/runner/recording/mapper（事件解析、进程管理、活动看门狗、失败分类）、pool/quota/oauth/pool-auth/net（账号池、双桶配额、PKCE 登录、代理感知 fetch）、sessions/media/models/discovery/diagnostics。
- **服务层（新写）**：Fastify 5 服务（§8）、鉴权中间件、SQLite 记账、配置装载。

## 4. 协议支持矩阵（核心交付）

内部统一 IR = dsh-agy-link 已验证的 StreamChunk 协议（block-start/text-delta/reasoning-delta/tool-call/usage/finish，不变式：usage 先于 finish、finish 后无事件、同一时刻至多一个开放块）。

### 4.1 端点

| 端点 | 级别 |
|---|---|
| POST /v1/chat/completions（stream + 非流式） | 完整 |
| POST /v1/messages（stream + 非流式） | 完整 |
| GET /v1/models（OpenAI shape：`{object:'model',id,created,owned_by}`）/ GET /v1/models（Anthropic shape：`{data:[{id,type:'model',display_name,created_at}],first_id,has_more,last_id}`，路径区分） | 完整 |
| GET /v1/models/{id} | 完整 |
| POST /v1/messages/count_tokens | 近似（以 agy usage 回推估算，响应注明非精确） |

> **M2 models 路由决策**：`/v1/models` 默认 OpenAI 形状，带 `anthropic-version` 头时返回 Anthropic 形状；新增 `GET /v1/anthropic/models` 恒为 Anthropic 形状（Anthropic SDK base_url 直填主机即可用）。

### 4.2 请求参数映射

| OpenAI | Anthropic | agy | 说明 |
|---|---|---|---|
| model | model | `--model` | 统一别名表；Gemini `-low/-medium/-high` effort 后缀折叠（复用 foldEfforts） |
| max_completion_tokens | max_tokens | 无直接对应 | 用于截断防护与记账；OpenAI 旧 `max_tokens` 接受但按弃用处理。**流式**：按 estimateTokens 启发式累计输出（text + reasoning + 工具参数，无 tokenizer，粒度为单个 delta），达上限即 abort agy 并终结——OpenAI `finish_reason:'length'` / Anthropic `stop_reason:'max_tokens'`；**非流式**：比例截断（现状） |
| reasoning_effort: none/minimal/low/medium/high/xhigh/max | thinking: {type:enabled(budget_tokens)/adaptive/disabled} | `--effort low/medium/high`（仅 Gemini） | 映射：none→不传 effort；minimal/low→low；medium→medium；high/xhigh/max→high；Anthropic enabled(budget) 按预算分档到 low/medium/high；adaptive→模型默认。**M2 budget 档位边界：budget_tokens ≤4096→low / ≤16384→medium / >16384→high** |
| temperature / top_p / top_k | （三者均已弃用，4.6+ 仅接受近似值） | 忽略 | 接受不报错；差异在文档注明 |
| stop / stop_sequences | stop_sequences | 不支持 | agy 无对应；两腿均网关侧后处理（"尽力"，字符串粒度）：**流式** SSE 层 holdback 缓冲——可能是任一 stop 前缀的文本尾巴扣留，命中即截断终结（只作用 text 流，reasoning 不截）；OpenAI `finish_reason:'stop'`，Anthropic `stop_reason:'stop_sequence'` + `stop_sequence` 回显；**非流式**最先命中截断 |
| response_format json_object | — | 无 | 系统提示注入（prompt instruction only——无网关侧 parse check，输出合法性非硬保证，warning 如实描述） |
| response_format json_schema{name,description,schema,strict} | output_config.format{type:'json_schema',schema} | `--json-schema`（原生） | 三方直接映射；解析结果取 result 事件的 `structured_output`；strict 仅透传语义 |
| tools + tool_choice | tools(input_schema) + tool_choice | agy 自有工具循环 | **受控工具执行（已确认）**：agy 工具循环开启；权限模式默认 `plan`；workspace 限定网关专用目录；agy 工具活动经移植的镜像机制切成 tool-call 块，两侧分别呈现为 OpenAI tool_calls（delta.tool_calls）往返 / Anthropic tool_use（content_block + tool_result）往返；`--dangerously-skip-permissions` 默认关闭，设置页显式开启并双重警示（§10）。**M2 决策：客户端 tools 定义接受但不执行**（不转发 agy、不注入 prompt，仅 warning），仅 agy 自有工具镜像为往返。**Anthropic 收尾 tool_result 保全**：末条 user 消息内多条 tool_result 文本 `'\n\n'` 合并、游标取 eventIndex 最大者、兄弟 text 块以 `[user context] ` 前缀并入 tool 消息（agy 已自执行工具，客户端结果仅为镜像续播的建议数据；engine 续播只看最后一条 role:'tool' 消息，并入是数据唯一存活路径） |
| image_url（detail 忽略）| image(base64) | 文件 staging + `--add-dir` | 复用 media.ts staging。**M2 仅支持 `data:`/base64**，http(s) URL → 400 明确报错；SSRF 安全 fetch 列为 M5 候选。document(PDF)/citations/search_result 块 → 400（上游能力 + v2 候选） |
| input_audio / audio 输出 | — | — | 不支持 → 400 明确报错 |
| stream_options.include_usage | usage 内建 | usage 事件 | OpenAI 端默认每块 usage:null，末块带 usage |
| metadata / safety_identifier / user | metadata.user_id | — | 仅入日志，不上游 |
| n（多候选）| — | — | v1 仅支持 n=1，n>1 返回 400 |

### 4.3 流式事件映射

| 内部 StreamChunk | OpenAI chunk | Anthropic 事件 |
|---|---|---|
| （流开始） | 首块 delta{role:'assistant',content:''} | message_start（usage.input_tokens = estimateInputTokens 启发式估值：messages + system + tools 定义 + tool_result 内文，非精确——count_tokens 同源） |
| reasoning-delta | delta.reasoning_content（业界惯例字段，官方文档无——实现并在文档注明） | content_block_start(thinking) + content_block_delta(thinking_delta) + signature_delta（signature 原样透传） |
| text-delta | delta.content | content_block_start(text) + content_block_delta(text_delta) |
| tool-call 块 | delta.tool_calls[{index,id,function{name,arguments}}] | content_block_start(tool_use,id,name) + content_block_delta(input_json_delta) |
| usage | 末块 choices:[] + usage{prompt_tokens,completion_tokens,total_tokens,prompt_tokens_details.cached_tokens,completion_tokens_details.reasoning_tokens} | message_delta usage.output_tokens（累计）+ usage.output_tokens_details.thinking_tokens |
| finish: stop | finish_reason='stop' + [DONE]（惯例哨兵，官方文档已不再列出——照常实现） | message_delta(stop_reason='end_turn') + message_stop |
| finish: tool-calls | finish_reason='tool_calls' + [DONE] | message_delta(stop_reason='tool_use') + message_stop |
| 流式 stop 命中 / max_tokens 达标（网关侧） | finish_reason='stop'（stop 命中）/ 'length'（预算截断） | message_delta(stop_reason='stop_sequence' + stop_sequence 回显 / 'max_tokens')；stop 命中不覆盖 tool-calls 终止（tool_use 块已发出，客户端须继续循环） |
| finish: error/aborted | SSE 内 error 负载或按惯例终止 | error 事件 {type:'error',error:{type,message}} |

**usage 映射**（agy → 两端）：`input_tokens`→prompt/input；`output_tokens`→completion/output（含 thinking）；`thinking_tokens`→OpenAI `reasoning_tokens` / Anthropic `output_tokens_details.thinking_tokens`；`cache_read_tokens`→OpenAI `prompt_tokens_details.cached_tokens` / Anthropic `cache_read_input_tokens`。无 cache 写入分解（两端对应字段置 0 或省略）。

**Anthropic 多轮 thinking 回放**：assistant 历史中的 thinking/redacted_thinking 块（含 signature）原样透传进上下文映射；网关不校验 signature（由上游处理）。

**M2 补充（signature）**：agy 不产生 thinking signature——thinking 块不带 `signature_delta`；网关亦不校验入站 signature（AN4 篡改腿因此 N/A，见 test/golden/anthropic/an4-thinking-replay/PROVENANCE.md）。

### 4.4 错误模型

- OpenAI 错误体 `{error:{message,type,code,param:null}}`（官方错误对象含 param，恒 null）；Anthropic 错误体 `{type:'error',error:{type,message},request_id}`（顶层 request_id = 网关请求 id；invalid_request_error/authentication_error/permission_error/not_found_error/rate_limit_error/api_error/overloaded_error）
- EngineError 码 → HTTP 映射：AUTH→401、UNKNOWN_MODEL/BUSY/AUX→4xx、TIMEOUT/PROCESS_EXIT/INVALID_OUTPUT/AGY_ERROR→502、限流→429
- agy 真实错误文本永远透传（继承 dsh-agy-link v0.4.21 经验：非 0 退出时优先取 result.error / stderr 尾部，而非笼统的 "exited with code 1"）；403 VALIDATION_REQUIRED 的 validation_url 必须出现在 message 中
- 硬限流（429 / "Individual quota reached" / "quota exceeded"）→ 账号冷却 + 自动切换（复用现有窄判定正则；agy 观测到的实际文本形式与该正则匹配，无需改动）；软限流（"model overloaded"）只透传不改账号状态

## 5. 模块移植清单（自 dsh-agy-link，MIT）

| 来源 | 处置 |
|---|---|
| parser.ts / runner.ts / recording.ts / discovery.ts / diagnostics.ts | 原样移植（零框架依赖已核实） |
| mapper.ts | 移植；解除 dsh-llm 3 个符号依赖（CallId/StreamChunk/TokenUsage 本地化） |
| mirror-tool.ts | **改造移植**：去 dsh-tools 视图类型与 run_code 双模（DSH 专用），保留 agy 工具活动→tool-call 块切分与 `agytc-<runId>-<eventIndex>` 游标续传 |
| adapter.ts | 重写为引擎入口 `engine.ts`：吸收 buildArgs/结算/重试策略/continuation 检测，抛自有 `EngineError{code}`（Err 码表照搬） |
| pool.ts / pool-auth.ts / quota.ts / oauth.ts / auth.ts / net.ts / sessions.ts / media.ts / models.ts | 原样移植；**禁用 systemHome 主账号路径**（bootstrapDefaultAccount），容器内全部隔离账号 |
| ask-tool.ts / commands.ts / client/ / mcp-bridge.ts | 弃用（DSH 专用） |
| common/config.ts + types.ts + pool-types.ts | 移植；`DSH_AGY_*` 前缀改 `AGY_PROXY_*`（保留兼容读取） |
| index.ts 的 17 个路由 handler | 改写进 Fastify 服务层 + **必须加鉴权中间件**（原实现零鉴权）；删除 osascript/cmd.exe 开终端路由，改"复制登录 URL" |

新增模块：openai-adapter、anthropic-adapter、key-store、usage-ledger、admin-api、web/（前端）。

## 6. 稳定性设计

**继承的已验证机制**（dsh-agy-link 已踩坑解决，直接移植）：
- stdin 立即 EOF（`agy models` / `-p` 在保持打开的管道 stdin 下永久挂死——官方 issue #882/#318 佐证）
- 活动看门狗 refreshWatchdog（stdout/stderr 每次数据重臂）+ 进程组整树 kill（Linux `detached:true` + `process.kill(-pid)`）
- 失败分类（TIMEOUT/AUTH/PROCESS_EXIT/INVALID_OUTPUT/限流）+ 快速重试（2s→10s 抖动）
- 非 0 退出时优先取 result.error/stderr 尾部真实原因
- 会话绑定原子写（tmp+rename），双平台验证

**v1 新增强化**：
- **空响应检测**：官方 #902 报告约 10% 长工具回合以 CANCELED/空响应结束 → 结算层把"CANCELED 或 response 为空"归为可重试失败，计入账号健康度
- **invalid_grant / 403 熔断**：立即冷却该账号不重试，WebUI 高亮；VALIDATION_REQUIRED 透传 validation_url
- **SSE 心跳**：反代/Cloudflare 存活（OpenAI 端发注释行 `: ping`，Anthropic 端发 `ping` 事件）
- **优雅停机**：SIGTERM → 停止接新 → 等待在跑 agy（带上限，docker `stop_grace_period: 30s`）→ kill 残留进程组 → SQLite checkpoint → 关闭 DB
- **崩溃恢复**：SQLite `journal_mode=WAL; synchronous=FULL; busy_timeout`；usage 记账以**服务端**请求 id 幂等去重（引擎级重试合并为一行；客户端自选 `x-request-id` 不作为记账键、仅观测透传——记账键可被客户端操纵会让每日预算形同虚设，S-H1 安全修复）；pool.json/sessions.json 损坏时自动备份重建
- **并发防护**：每账号串行队列（p-queue `concurrency:1`，已实现——同时消除同账号并发互踩会话绑定的竞态）+ 全局队列深度上限（超出即 429 BUSY）+ 客户端断连（AbortSignal）级联取消 agy 进程。调度补强（M5）：选择时跳过有在跑/排队的账号（busy-aware 参与参数），并发请求横向铺开而非堆叠一个账号的队列——验收 §4「互不阻塞 / ≥2.5× 吞吐」的结构性前提
- **引擎级单次重试（M5 落地）**：仅覆盖无线上输出的故障类别（TIMEOUT / PROCESS_EXIT / 无结果 INVALID_OUTPUT），按 RETRY_POLICY 抖动延迟后重选账号重跑；任何已下发客户端可见输出（任一 step 事件）或结果形态可终止 span 的失败一律不重放。`RETRYABLE_CODES/RETRY_POLICY` 自 ADR-11 移植以来首次接入消费者
- **硬限流语义（M3 修订，用户定案）**：in-flight 请求遇上游硬限流 = 该请求失败（上游真实错误透传），账号进冷却；**自下一个请求起自动切换**到池内其他账号——请求粒度的透明切换，而非中途透明重放（agy 无部分续传，跨进程重放需重新计费且会破坏会话绑定；**M5 复议定案：维持本决策**——重试机器已落地为引擎级单次重试，仅覆盖无线上输出的故障类别，与透明重放语义正交，见 §6 重试行）。全池冷却/隔离时返回 429 `POOL_EXHAUSTED` + `Retry-After`（取最早重置时刻倒计时）
- **版本锁定**：Docker 构建期固定 agy 版本 + `AGY_CLI_DISABLE_AUTO_UPDATE=true`；启动探测 `agy --version`（最低版本可配置）
- **PID 1**：容器内 tini（或 `docker run --init`）——转发 SIGTERM + 回收 zombie（每请求 spawn 短命子进程，zombie 回收不可省）

## 7. 性能与速度设计

- **延迟模型**：每请求 spawn 一个 agy 进程（官方 CLI 路线）。开销 = agy 冷启动 + 首字延迟，v1 接受（成熟可靠）；**v2 评估**：`--input-format stream-json` 常驻会话池（官方多轮 stdin 协议，可省冷启动；复杂度高，单列实验分支）
- **吞吐**：并发度 = 账号数（每账号串行，防风控与竞态）；跨账号真并行
- **流式**：parser 逐行 → mapper → SSE 直通，无缓冲聚合；Fastify `reply.hijack()` + `reply.raw` 写流，背压交 Node stream
- **记账开销**：usage 写 SQLite 异步批量（内存缓冲 + 定时 flush + 关停前 flush），不阻塞流
- **模型目录**：`agy models` 缓存 TTL 300s + stale-while-revalidate + 内置 fallback 目录（移植）
- **资源 sizing**：容器内存 ≈ 并发 agy 进程数 × ~150MB + 基线 ~200MB；文档给出配表（如 3 账号 → 1GB+）

## 8. 技术选型（2026-08-30 核实定稿）

| 领域 | 选型 | 版本 | 备选与理由 |
|---|---|---|---|
| HTTP 框架 | **Fastify** | ^5.12 | Hono 4.13 作备选（edge 可移植性对固定 VPS 无意义，Node 适配层多全局改写）；h3 v2 仍 RC；Fastify v6 仅 alpha——锁 ^5 |
| 请求校验 | **TypeBox** | ^0.34 | Fastify 原生 JSON Schema 编译（校验+序列化双用）；zod-type-provider 备选 |
| WebUI | **React 19 + Vite 8 + TanStack Router/Query + shadcn/ui + Tailwind v4** | 19.2 / 8.2 / — / — / 4.3 | new-api（46.8k★）同款栈，LLM 网关面板已验证；antd 6.6 作备选（致密中文表格开箱即用，代价 CSS-in-JS 运行时） |
| 持久化 | **better-sqlite3 + WAL** | ^13 | node:sqlite 在 Node 24 LTS 仍实验性（RC），密钥/账本库不冒险；命名卷，禁网络 FS 挂载 |
| 进程编排 | **p-queue 每账号一队列** | ^9 | M3 实际落地为 concurrency:1 + AbortSignal 贯通；RPM 限流改由 auth hook 的 rate-limiter-flexible 承担（未用 intervalCap）；p-limit 作最小备选 |
| key 限流 | **rate-limiter-flexible (Memory)** | ^11 | 固定窗口够用；Retry-After/X-RateLimit 头现成；Redis 升级路径预留 |
| API key 存储 | **sha256 哈希 + 前缀明文**（LiteLLM 模式） | — | 高熵 key 无需慢哈希；argon2 仅用于管理员登录密码 |
| Admin 会话 | **DB opaque session（自研 ~50 行）** | — | Lucia 已弃用（2025-03）；httpOnly+SameSite=Lax cookie；jose JWT 备选 |
| 日志 | **pino → stdout NDJSON** | ^10 | Fastify 原生；pino-pretty 仅 dev worker 传输；OTel 推迟（Logs SDK 仍 Development 状态） |
| 静态 WebUI 托管 | **@fastify/static** | ^8 | M4 增补（用户定案）；`wildcard:false`（逐文件路由，不遮蔽 /v1、/admin、/healthz）+ 应用层 SPA fallback（保留协议形 404）；备选零依赖手写 handler（未采信——Range/MIME/缓存边角自担成本更高）。**§9 表格虚拟滚动在 M4 未引入**（usage 服务端分页 ≤500 行） |
| 测试 | **vitest** | ^4.1 | 原生 TS/ESM；Fastify `inject()` 测路由 + 真监听 fetch/ReadableStream 测 SSE + fake-agy 桩测全链路（fake-agy 思路继承自 dsh-agy-link） |
| i18n | **react-i18next，zh-CN 默认** | 17 / 26 | new-api 同款模式：首次访问语言探测 + 手动切换持久化 |
| 容器 | **tini 作 PID 1 + Node 24 LTS** | — | zombie 回收 + 信号转发；agy 官方 install.sh 构建期安装 + 版本锁定 |

## 9. WebUI 设计（美观 + 实用）

页面（中文优先，EN 切换）：
1. **登录**：管理员密码（argon2 哈希），可选 `ADMIN_ALLOW_CIDR` 限定
2. **仪表盘**：今日请求数/成功率/Token 用量/活跃账号、最近错误流（SSE 实时推送）
3. **账号池**：卡片式——每账号邮箱、5h/7d 双桶配额条（Google 官方配额端点，移植 quota.ts）、冷却倒计时、健康状态、登录（粘贴回调 URL 流程 + QR 码）、启用/禁用、代理设置
4. **API Keys**：创建（sk- 前缀）、明文仅展示一次、哈希存储、前缀辨识；每 key 限额（请求/Token/日）、模型白名单、启用/禁用
5. **用量日志**：按 key/模型/账号/状态过滤，耗时/Token/错误文本，导出 CSV
6. **设置**：默认模型/effort/超时/并发、权限模式（skip-permissions 二次确认 + 警示横幅）、版本信息

设计原则：深/浅双主题（系统跟随 + 手动）；实时数据全部 SSE（TanStack Query + EventSource，Last-Event-ID 续传）；表格虚拟滚动（TanStack Virtual）；空状态引导文案；shadcn 中性简洁风，避免"企业控制台"审美；移动端响应式可用。

## 10. 安全设计

- **API key**：sha256 哈希 + 前 8 位前缀辨识；每 key RateLimiterMemory 限流 + 429 带 Retry-After；模型白名单**已落地（M5）**——`getScopes(keyId)` 引擎预 spawn 对实际服务模型（fallback 解析后）判定，`Err.MODEL_NOT_ALLOWED` → 双协议 403 permission_error；根 key 与未配置白名单的 key 旁路（空=不限，非 deny-all）
- **Admin 面**：argon2 密码 + DB session（哈希落库、可吊销）；同源 SPA + SameSite=Lax；admin 变更路由要求自定义头（X-Requested-With）作 CSRF 双保险；默认监听 127.0.0.1、由反代对外
- **agy 权限（受控工具执行）**：workspace 限定网关专用目录（每账号独立子目录），权限模式默认 `plan`；`--dangerously-skip-permissions` 默认关闭，设置页开启需二次确认 + 全程警示横幅（skip = key 持有者可在容器内执行任意命令——本立项最大单点风险）；`--sandbox` 兼容性评估列入 M5（官方 issue #36：不可与 skip 组合）
- **凭证卫生**：token material 永不复制/导出/入日志；quota 轮询**就地读写**账号自身 token 文件（`getStoredToken`/`persistRefreshedToken`：读取 access/refresh 供配额端点认证，过期即用 refresh_token 刷新并回写**原文件原格式**——agy 与轮询共享同一份新鲜凭证，避免每次轮询重复刷新；token 是唯一可信身份锚点，防止取错账号配额）；doctor 式脱敏（auth URL / `4/` 授权码 / `ya29.` / Bearer 全 scrub）
- **传输**：TLS 交反代；`TRUSTED_PROXIES` 解析真实 IP（限流与日志）
- **上游纪律**：代理/刷新节奏保守（继承配额轮询默认 15min）；不做 token 导出/导入功能

## 11. 风险与对策

| 风险 | 等级 | 对策 |
|---|---|---|
| ToS 第 6 条（第三方工具接入） | 高 | 坚守官方二进制路线；文档免责声明；不碰 token 导入导出；文档建议使用非主力账号 |
| VPS 云 IP + 刷新频率触发风控（AIClient2API #400 实锤停号；opencode-antigravity-auth #526 实锤 403 ToS-disable） | 高 | 保守刷新节奏；冷却/熔断；validation_url 透传；README 明示风险自担 |
| token 设备绑定，凭证跨机移植失败（官方 #223） | 中高 | 全部账号在容器内登录（粘贴回调 URL / SSH 隧道）；**/data 持久卷承载全部状态** |
| 免费档配额不可用（5-10 分钟烧完、周刷新） | 中 | 面向 Pro/Ultra 订阅账号设计；配额条前置可见 |
| agy 无头可靠性（#902 空响应 ~10%、#318 非TTY挂死、#882 models 挂死） | 中 | §6 全套机制（看门狗/stdin EOF/空响应重试/失败分类） |
| 地区限制（FAILED_PRECONDITION "location not supported"） | 视部署 | 启动自检 + 错误透传；文档列出支持地区 |
| 同名项目 kqlio67/agy-proxy（0★，GPL-3.0，Python） | 低 | 无实质冲突；发布命名加 owner 前缀区分 |
| 先例代码 license（gcli2api CNC-1.0 / antigravity2api CC BY-NC-SA / AIClient2API GPL-3） | 法律 | **仅 clean-room 自研 + 复用 MIT 的 dsh-agy-link 自有代码**；不搬运上述项目任何代码 |

## 12. 里程碑

- **M0 骨架**（0.5 周）：新仓库、CI 三闸（typecheck/build/test）、Docker 骨架（tini + agy 锁版）、config 层
- **M1 引擎移植**（1 周）：§5 清单落地 + engine.ts + fake-agy 测试全绿 + OpenAI 端点非流式跑通
- **M2 双协议完整**（1 周）：流式两端、tool_calls/tool_use 往返、count_tokens、models、错误模型、SSE 心跳
- **M3 池与记账**（1 周）：账号池全功能（粘贴 URL 登录/配额/冷却/熔断）+ key 管理 + SQLite 记账
- **M4 WebUI**（1-1.5 周）：§9 全部页面 + SSE 实时推送
- **M5 加固发布**（1 周）：镜像发布、反代文档（nginx/Caddy/Cloudflare）、压测、错误矩阵演练、v0.1.0。**M5 交付状态**：加固面全部落地（账本 flush 容错 / settings .tmp 清理 / 计时器 unref / media TTL 清扫 / 客户端边界 token 脱敏 / 引擎级单次重试 + busy-aware 铺开 / 每 key 白名单 enforcement / errorText schema v2 / soak.mts + perf.mts / compose + deploy runbook）；演练归档进行中（docs/verify/m5.md）。真实登录、配额条人工核对、容器强杀（VPS）、48h 长稳为用户执行项。版本保持 0.1.0，发版动作等待显式发布指令

**M5 验收标准**：fake-agy 全部测试 + 真实账号端到端双协议（流式/非流式/tool 往返）回归；48h 长稳跑无进程/句柄/内存泄漏；容器强杀重启自动恢复；错误场景矩阵（断网/过期 token/429/杀 agy 进程/磁盘满）全部按预期降级。

---

## 附录 A：事实出处索引

- agy 官方：antigravity.google/docs/cli/{headless,install,modes,reference,credits}、/docs/models、/docs/plans、/terms（第 6 条）、github.com/google-antigravity/antigravity-cli（issues #223/#318/#368/#882/#898/#902/#53/#78 等）
- 先例项目：github.com/router-for-me/CLIProxyAPI（49.3k★ MIT）、QuantumNous/new-api（46.8k★）、su-kaka/gcli2api（5.1k★ CNC-1.0）、justlovemaki/AIClient2API（8.7k★ GPL-3，#400 EC2 停号）、NoeFabris/opencode-antigravity-auth（11k★，#526 ToS 403）、diegosouzapw/OmniRoute（58k★，REMOTE-MODE.md）、badrisnarayanan/antigravity-claude-proxy（3.9k★，封号警告）
- 协议规格：openai-node SDK src（GitHub master，2026-08-30 拉取）、platform.claude.com/docs（messages/streaming/thinking/caching/stop-reasons/count-tokens/models-list）
- 引擎可移植性：dsh-agy-link 源码逐模块 import 审计（2026-08-30）
- 技术选型版本：npm registry / 各官方 release 页（2026-08-30 拉取）
