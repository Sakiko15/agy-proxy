# agy-proxy 验收标准

版本 v0.1（2026-08-30）· 配套文档：[charter.md](./charter.md)、[development.md](./development.md)

规则：每条验收项必须**可执行验证**（给出命令/脚本/观察点），禁止"功能正常"式表述。里程碑验收 = 该章全部条目通过 + 之前里程碑无回归。

## 1. 通用闸门（每个里程碑都要过）

| # | 验收项 | 验证方式 |
|---|---|---|
| G1 | CI 三闸全绿 | GitHub Actions 该 commit 的 run：check → build → test 全部 success |
| G2 | 测试全部通过且无跳过 | `npm test` 退出码 0；`grep -r "\.skip\|\.todo" test/` 无结果（豁免需 PR 说明） |
| G3 | 类型零容忍 | `npm run check` 退出码 0；无 `@ts-ignore`/`@ts-expect-error`（确需时注释须引用协议文档 URL） |
| G4 | 安全红线扫描 | `grep -rEn "console\.log" src/` 无结果；脱敏单测通过；日志中无 key/token 明文（用 fake key 走一遍请求后 `grep` 日志文件验证） |
| G5 | 无进程/句柄泄漏增量 | 本里程碑测试套件运行前后，容器内 `agy` 进程数、Node 句柄数（`process._getActiveHandles().length` 基线记录）回归后无净增 |

## 2. 协议一致性验收（golden 用例体系）

golden 用例存放 `test/golden/<protocol>/<case>/`：每目录含 `request.json`（入站请求）、`events.ndjson`（fake-agy 桩输出序列）、`expected.json`（期望响应/SSE 事件序列，人工审阅维护）。断言逐字段比较，字段级 diff 输出到失败信息。

**用例来源纪律**：每个 golden 场景必须在 `expected.json` 头部注明依据来源（OpenAI SDK 源码路径 / platform.claude.com 文档 URL）。无来源的用例不得合入。

### 2.1 OpenAI Chat Completions（/v1/chat/completions）

| # | 场景 | 关键断言点 |
|---|---|---|
| OA1 | 基础非流式（单轮文本） | `id` 格式、`object:'chat.completion'`、`created`、`model` 回显、`choices[0].message.role/content`、`finish_reason:'stop'`、usage 三元组 |
| OA2 | 流式基础 | 首块 `delta:{role:'assistant',content:''}`；中间块 `object:'chat.completion.chunk'` 且 id 全程一致；末块 `finish_reason:'stop'` + `[DONE]`；`stream_options.include_usage` 时仅末块带 usage 且 choices:[] |
| OA3 | reasoning（thinking 模型） | `delta.reasoning_content` 出现在 content 之前；`completion_tokens_details.reasoning_tokens` = agy `thinking_tokens`；`prompt_tokens_details.cached_tokens` = agy `cache_read_tokens` |
| OA4 | tool_calls 往返 | delta.tool_calls 索引连续、`id` 稳定、arguments 为字符串形式的合法 JSON 片段拼接后可 parse；`finish_reason:'tool_calls'`；后续带 tool role message 的请求正确续传（agytc 游标复用，不新 spawn） |
| OA5 | response_format json_schema | 请求透传 `--json-schema`；响应 `message.content` 为可 parse 且通过 schema 校验的 JSON；错误时 400 带上游文本 |
| OA6 | reasoning_effort 全档 | none/minimal/low/medium/high/xhigh/max 七档 → 引擎收到的 `--effort` 参数符合 charter §4.2 映射（xhigh/max→high；none→不传）；非 Gemini 模型传 effort 时表现为忽略而非报错 |
| OA7 | 多模态 image_url | base64 图片经 media staging 落盘、`--add-dir` 注入；tiff 等不支持格式返回 400 |
| OA8 | 错误矩阵 | 无效 model→404/400 带模型列表提示；无效 key→401 `invalid_api_key`；上游退出码 1 → 502 且 error.message 含 agy 真实错误文本（非 "exited with code 1"） |
| OA9 | 参数弃用面 | `max_tokens` 可用；`functions`/`function_call` → 400 提示改用 tools；`n>1` → 400；`input_audio` → 400 明确说明不支持 |
| OA10 | max_tokens 截断 | 输出达到 max_completion_tokens 时 finish_reason='length'（网关侧截断生效） |

### 2.2 Anthropic Messages（/v1/messages）

| # | 场景 | 关键断言点 |
|---|---|---|
| AN1 | 基础非流式 | 响应 `id:'msg_...'`、`type:'message'`、`role:'assistant'`、`stop_reason:'end_turn'`、`usage.input_tokens/output_tokens`、`anthropic-version` 头校验（缺失时按最新兼容处理） |
| AN2 | 流式完整序列 | 事件顺序 message_start → (content_block_start → delta* → content_block_stop)+ → message_delta → message_stop；text_delta 拼接 = 非流式 content；message_delta.usage.output_tokens 单调不减 |
| AN3 | thinking 流式 | thinking 块：content_block_start(type:'thinking') → thinking_delta* → signature_delta → stop；`output_tokens_details.thinking_tokens`（末个 message_delta）= agy thinking_tokens；redacted_thinking 块透传 |
| AN4 | thinking 回放 | 历史消息中的 thinking/redacted_thinking（含 signature）原样透传进上下文；signature 被篡改时上游错误原样返回（网关不校验不修改） |
| AN5 | tool_use 往返 | content_block_start(tool_use) + input_json_delta 拼接可 parse；stop_reason='tool_use'；tool_result 回传后正确续传（游标复用） |
| AN6 | system 多形态 | string 与 [{type:'text',text,cache_control?}] 两种形态等价处理 |
| AN7 | count_tokens | 返回 `{input_tokens:number}`；与实际运行 usage 的 input 偏差在文档标注范围内（±30% 内，近似声明） |
| AN8 | 错误矩阵 | 无效 key→401 `authentication_error`；上游过载→`overloaded_error`；请求体非法→400 `invalid_request_error`；错误体统一 `{type:'error',error:{type,message}}` |
| AN9 | output_config json_schema | 与 OA5 等价断言；structured_output 从 result 事件取出 |
| AN10 | stop_sequences | 尽力模式：命中时网关截断 + stop_reason='stop_sequence' + stop_sequence 字段回填命中值 |

### 2.3 模型与鉴权面

| # | 场景 | 断言 |
|---|---|---|
| MA1 | GET /v1/models（OpenAI shape） | `{object:'list',data:[{id,object:'model',created,owned_by}]}`；无重复 id（INVALID_CATALOG 防御） |
| MA2 | GET /v1/models（Anthropic shape） | `{data:[{id,type:'model',display_name,created_at}],first_id,has_more,last_id}`；after_id/before_id 分页可用 |
| MA3 | Gemini effort 折叠 | `-low/-medium/-high` 后缀折叠为单条目；无裸 base 重复条目 |
| MA4 | key 鉴权矩阵 | Bearer 头缺失/无效/禁用/超限 → 401/401/403/429+Retry-After；X-Api-Key 头同样支持（Anthropic 客户端惯例） |
| MA5 | 每key限额 | 超日 Token 限额 → 429 错误体指明额度类型与重置时间；记账与实际 usage 一致（±1 请求容差） |

## 3. 里程碑 DoD

### M0 骨架
- [ ] 新仓库 + CI 三闸跑通（G1–G3）
- [ ] Docker 镜像构建成功：tini PID 1、agy 官方 install.sh 安装、`AGY_CLI_DISABLE_AUTO_UPDATE=true`、版本锁定
- [ ] config 层：`AGY_PROXY_*` 环境变量全表生效（对照 charter §4.2/README 配置表逐项 shell 验证）
- [ ] 容器内 `agy --version` 探测通过；无网络时启动给出明确 dormant 原因

### M1 引擎移植
- [ ] §5 移植清单落地；移植文件头注释含源 sha（G4 检查移植提交纪律）
- [ ] fake-agy 全部既有模式测试通过（ok/auth/noise/exit12/exit-error/real/real-error/real-fail）
- [ ] stdin EOF、看门狗、进程组 kill 行为与 dsh-agy-link 基线一致（用 fake-agy 挂死模式验证 kill 生效）
- [ ] OpenAI 非流式端到端（OA1）经真实 agy 二进制跑通一次并记录

### M2 双协议完整
- [ ] OA2–OA10、AN1–AN10、MA1–MA3 golden 用例全部通过
- [ ] SSE 心跳：流式请求中间静默 >60s 时 OpenAI 端出现 `: ping`、Anthropic 端出现 ping 事件（fake-agy slow 模式验证）
- [ ] count_tokens 上线（AN7）
- [ ] 错误矩阵演练：OA8/AN8 全场景人工触发并截图/录屏存档 `docs/verify/`

### M3 池与记账
- [ ] 账号登录：粘贴回调 URL 流程在无浏览器容器内完成全流程；QR 码可显示
- [ ] 配额条数据与 Google 官方端点一致（对同一账号同时人工核对一次）
- [ ] 429 演练：fake-agy 触发硬限流文本 → 账号冷却 + 请求自动切到下一账号成功；全部冷却时返回 429 带重置倒计时
- [ ] 403 VALIDATION_REQUIRED 演练：validation_url 出现在 API 错误 message 与 WebUI 中
- [ ] key 生命周期：创建/明文仅一次/禁用/删除；sha256 落库验证（sqlite3 CLI 查库确认无明文）
- [ ] 记账幂等：一次请求至多一行——引擎级重试由服务端 request id 合并（客户端自选 `x-request-id` 不作为记账键，仅观测；重放同一请求各自记账。安全修复 S-H1 后的语义）
- [ ] 崩溃恢复：`docker kill` 后重启，pool.json/sessions.json/SQLite 状态完好、无孤儿 agy 进程（容器内 `ps` 验证）

### M4 WebUI
- [ ] charter §9 六页面全部可用；zh-CN/EN 切换完整（无硬编码文案残留：`grep -r "[一-龥]" web/src --include="*.tsx"` 仅出现在 i18n 资源文件）
- [ ] SSE 实时推送：发起请求时仪表盘/日志页无需刷新即更新
- [ ] 深浅主题切换、移动端 375px 宽度可用（人工核对截图）
- [ ] admin 未认证访问任意 API → 401；skip-permissions 开关有二次确认
- [ ] Lighthouse a11y ≥ 90（生产构建 + 运行中面板）

### M5 加固发布
- [ ] 48h 长稳：3 账号、持续混合负载（流式/非流式/tool/错误注入），RSS 增长 < 10%、句柄数回归基线、无 zombie（`ps axo stat` 无 Z）
- [ ] 强杀恢复演练 ×3：`docker kill --signal=SIGKILL` 后重启自动恢复、SQLite WAL 回放正确、数据零丢失（记账对账）
- [ ] 错误场景矩阵全部通过：断网（agy 超时→502+真实错误）、过期 token（→401+账号熔断）、杀 agy 进程（→PROCESS_EXIT 重试）、磁盘满（→ 明确 5xx 而非 crash）
- [ ] 反代验证：nginx 与 Caddy 各一遍（SSE 不缓冲、心跳穿透、client_max_body_size 足够、真实 IP 透传正确记入日志）
- [ ] 安全终检：fake key 全链路后 `grep` 全部日志与 SQLite 无明文；`/admin` CIDR 限制生效；未授权路由清单审计
- [ ] 性能基线入档 `docs/verify/perf.md`：SSE 首 delta 延迟（网关 vs agy 直跑差值 < 50ms，3 账号并发）、非流式总延迟差值 < 100ms、单账号 RPM 上限生效
- [ ] `docs/verify/` 存档全部演练证据（日志片段/截图/录屏/命令输出）

## 4. 性能验收基线（M5，锚定"性能和速度"目标）

| 指标 | 阈值 | 测法 |
|---|---|---|
| SSE 首 delta 附加延迟 | < 50ms（对比裸 spawn agy 取首行） | 脚本各跑 20 次取 P50/P95 |
| 非流式总延迟附加 | < 100ms | 同上 |
| 流式吞吐 | 网关侧转发速率 ≥ agy 产出行速率（无积压：队列长度恒为 0-1） | fake-agy 高速产线模式 + 计数器 |
| 记账写路径 | 请求完成到 usage 落库 P95 < 2s（批量 flush 窗口内） | 时间戳对账 |
| 模型列表 | 冷启动 < 1.5s（缓存命中时 < 10ms） | 计时 |
| 3 账号并发 | 并发 3 路流式请求互不阻塞、总吞吐 ≥ 单账号 × 2.5 | 并发压测脚本 |

## 5. 验收执行纪律

- 每条验收在 `docs/verify/<milestone>.md` 记录：日期、commit sha、执行人、证据链接
- 验收失败 → 修复后**全量重跑该章**，不允许只重跑失败项
- 验收标准修改需独立 PR + 依据引用（协议文档 URL / issue 链接），并与 golden 用例同步更新
