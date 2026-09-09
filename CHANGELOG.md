# Changelog

All notable changes to agy-proxy are documented here. Format based on Keep a Changelog; versions follow semver.

## Unreleased

### Changed

- **maxTokensDefault 接线：输出预算抬底 + 未传缺省**：`maxTokensDefault`（默认 65536，env `AGY_PROXY_MAX_TOKENS_DEFAULT`，此前是接了分层却无任何消费点的死配置）现在由两协议适配器消费（`src/server/max-tokens.ts`）——客户端 `max_tokens`/`max_completion_tokens` 低于 65536 抬到底值、OpenAI 未传以底值兜底；`0` = 关闭（完全尊重客户端，未传不设限）。根因：OpenAI SDK 常默认发 1024/4096 小上限，流式腿达限即 abort agy 把长回答截成 `length`（0.3.x 的 ABORTED 分析确认这是健康运行失败的主因）。客户端校验（正整数）先于抬底不变；新增 env 层读取（此前该键只有 overrides 文件层）；`oa10-truncation` golden 经 `case.json` 钉 `maxTokensDefault: 0` 继续验证裸客户端上限截断。不进 settings 管理白名单（协议可见行为，env/overrides 级）。

### Fixed

- **ABORTED 记账细分**:流式 `max_tokens` 预算截断此前被记为 `ABORTED / agy run aborted by caller` 失败——但客户端收到的是成功的 `length`/`max_tokens` 终止,健康运行在面板成功率里被记为失败、进错误列表。现在四类主动终止按原因分类(引擎按 `AbortSignal.reason` 识别,route 在预算截断时传入 `output-budget`):截断结算为正常完成(ok/OK,记一次成功账);客户端断连/关停排水/steer 抢占仍记 ABORTED,但错误详情写明具体原因,不再是笼统的 "aborted by caller"。wire 字节不变、无新状态码、面板零改动,仪表盘成功率自动修正。

## 0.3.1 - 2026-09-09

### Changed

- **compose 默认镜像改拉 `:latest`**:`image` 默认 `ghcr.io/sakiko15/agy-proxy:latest` + `pull_policy: always`——`restart: unless-stopped` 只重启本地镜像、永不重拉,如今每次 `docker compose up -d` 都重新拉最新发布镜像;`AGY_PROXY_IMAGE` 覆盖保留(ghcr 不通时指向本地构建,deploy.md 路径 A)。deploy.md 三处旧引用(`0.2.0`/`docker.io`)同步。
- **思考占位行移除**:`[agy thinking turn · N thinking tokens]` 注释行(含其未发布的中间改版 `[Gateway note — …]`)整体删除。根因:agy print 模式不导出思考文本,该行由网关纯合成(mapper),接收方把它误读为上游返回的模型输出;干脆不发——纯思考回合的 reasoning 流为空,思考量只经 usage 上报(OpenAI `reasoning_tokens` / Anthropic `output_tokens_details.thinking_tokens`,记账不变)。mapper 的 placement/deferral 逻辑(上游 v0.3.2/v0.3.3 回归的修复)随占位行一并删除——占位不存在,无需安置。wire 字节变更:8 个 golden 去掉思考块/帧,PROVENANCE/README/测试同步;真思考文本路径(stepKind thinking,如 oa2/an5)与 `[agy subagent]`/`[agy finished with error]` 标注不变。

## 0.3.0 - 2026-09-08

功能批次(密钥可逆存储 reveal/rotate、usage 账号列、模型自动发现)、M1–M4 审计加固、S1–S9 稳定性批次、P1–P6/B3/B4 性能战役(契约:golden 双协议逐字节一致)、docker 发布链修复,以及一轮 /code-review 全量修复(15 条,5 批次)。闸门:check/build + 562 tests(55 files,0.2.0 时为 458)+ web check/test 24 + console.log grep 干净;perf 8/8 legs、soak 30min 23/23(RSS p50 203M,零 5xx 出窗)。

### Added

- **密钥 reveal/rotate(schema v3)**:plaintext 以 AES-256-GCM 密文入库(`keys.secret_enc`),密钥是卷内 sidecar `keys-enc.key`(0600,与 DB 同备份生命周期);hash 仍是唯一鉴权材料。管理台新增复制/轮换。根因:此前的单向 sha256 无法支撑 WebUI 的复制/轮换;密文不是明文,M3 的 sqlite3 落库红线保持成立。
- **usage 账号列 + 过滤 + CSV 导出**:ledger 行携带 accountAlias/accountEmail,usage 页新增账号列/过滤/导出(M1 根因:/admin/usage 此前不转发 protocol/status 过滤,WebUI 过滤器静默失效,面板成功率恒显 100%)。
- **模型自动发现**:`agy models` 在已登录池账号的隔离 HOME 内 spawn,60s poller 驱动、300s catalog TTL 后 stale-while-revalidate,失败指数退避(60s·2ⁿ,上限 10min);/admin/status 详情 + POST /admin/catalog/refresh + 仪表盘卡片;fallback 列表新增 gemini-3.8-flash(agy 1.1.22 实证)。
- **降级启动(S3)**:`enabled=false` 不再 exit 1——startup() 分类结果(ready / disabled / binary-missing / binary-probe-failed / binary-too-old),disabled 与 ready 一样完成全量装配并监听;/v1/* 回 503,/healthz、/admin、WebUI 在线,在线翻回 enabled 即刻生效,不再有 supervisor 对 crashloop 容器的拉锯。二进制类失败仍响亮 exit 1(快速暴露错误部署)。
- **usage 保留期**:`AGY_PROXY_USAGE_RETENTION_DAYS`(ops 级,默认 0 = 永久保持既有行为)>0 时小时清理器按本地零点对齐裁剪 ledger 行与池 auth 日志。
- **Web 预压缩交付**:vite closeBundle 产出 .gz(level 9)+ .br 兄弟文件(零新依赖),@fastify/static preCompressed 协商、字节等价回退;主 bundle 517KB → 138KB(brotli)。

### Changed

- **发布链迁移 ghcr.io**:docker-release workflow 推 `ghcr.io/sakiko15/agy-proxy:<version>` + `:latest`,用 workflow 自身 GITHUB_TOKEN(packages:write)授权——零 registry secrets,发布即一次手动 dispatch;compose 默认镜像与 deploy runbook 同步。
- **镜像自包含构建 + 构建期闸门**:根因 1——node:24-slim 无工具链、better-sqlite3 预编译包在该目标缺失,源码构建死于缺 python3/make/g++ → build 阶段补装,npm prune 后 runtime 复用 node_modules(一次原生编译);根因 2——buildkit 把相对路径 COPY 源解析到 stage 根而非 WORKDIR → 绝对路径;根因 3——npm ≥ 11.6 浮动策略可能跳过依赖安装脚本(npm ci 一次有 warn 一次没有)→ package.json `allowScripts` + 构建后 `require('better-sqlite3')` 绑定闸,失败在构建期而非 VPS 运行期。
- **compose 卫生(S9)**:json-file 日志轮转 10m×3;堆上限 `--max-old-space-size=512` 写进 CMD 而非 NODE_OPTIONS——后者会被每个 agy 子进程继承(sanitizeChildEnv 只剥 AGY_PROXY_*),静默钳死上游 CLI 堆;soak RSS 峰值 ~226MB,余量 >2×。
- **shutdownGraceMs(S2)**:默认 25s(env `AGY_PROXY_SHUTDOWN_GRACE_MS`;子 1s 值拒绝不收窄);preClose 在 app.close() 前同步 flush ledger——close 挂死过 grace 被 SIGKILL 也不丢缓冲行;compose stop_grace_period 30s→40s,charter §6 文档侧同步。
- **进程级兜底(S1c)**:uncaughtException/unhandledRejection 原样记录、flush ledger、exit 1——凭证持有网关在未捕获异常后的状态不可信;docker `restart: unless-stopped` 兜成干净恢复。

### 性能与稳定性战役(B1–B3)

- **S1 派发守卫**:engine 派发 IIFE 内的 releaseOnce/settle/untrackBusy 逐一包裹,内部失败不再楔死信号量槽、recording 或 busy 标记;driveSpan 泵内 EventMapper 构造移入守卫区(构造抛错曾让 chunk queue 永远开着——SSE 挂死),failure 路径全抛时也有保底 usage+finish 终帧,queue.close() 无条件进 finally。
- **P1/P2/P5/P6 字节等价性能批次**(golden 27/27 逐字节一致为准入契约):P1 runner stdout 尾缓冲自由追加、过 2×64KB 窗口才裁一次(20k-chunk run 曾付 ~1.3GB 瞬时分配);P2 parser 起点游标扫描 + 每 feed 一次压缩(逐行 slice 复制的 O(C·k/2) memcpy 消失,分块等价测试 1..4096);P5 sessions set/delete/clear 500ms 去抖持久化,损坏文件隔离为 `.corrupt-<ts>` 后按默认重建(不再无声重置);P6 SSE dataAll/eventAll 批量写(Anthropic 腿每 chunk 最多 3 次 raw write → 1 次,wire 字节不变)。
- **B3 准入公平性 + 每请求 CPU**:semaphore.acquire 接 AbortSignal——停车 waiter 随断连离开队列,死连接堆积不再饿死活连接(settled latch、abort 前摘除、release skip-and-retry 守卫,H3 直交保持);auth 期望侧摘要 memo(attacker-controlled 输入侧仍每次现算);key-store `scopesOf()` 冻结缓存(此前每请求 row fetch + JSON.parse);/admin/keys 的 per-key SUM 移入 tokensTodayCache(O(1) 推进);config overrides→base 分层 `buildBase()` 按 stat 身份 memo(每请求一次 → 每文件变更一次);/admin/qrcode 惰性导入。附带:每个 pre-dispatch 抛错清理已建好的 --json-schema 临时目录。

### Fixed

- **审计批次 M1–M4**:
  - M2 `sanitizeChildEnv` 剥离一切 `AGY_PROXY_*`(engine envFor + catalog discovery)——agy 子进程的 tool loop 可读自身 env,根密钥/管理密码曾直达。
  - M3 quota `persistRefreshedToken` 改 tmp+rename——直接覆写让并发 agy spawn 读到撕裂 JSON,把健康账号无自愈地隔离(poll 跳过 authRequired)。
  - M4 `agyFetch` 默认 10s abort——undici 300s header timeout 让一个挂死端点把配额周期堆过 15min 间隔叠加到同一批账号。
  - F12 每账号配额 lastError 通道(成功即清),进池 REST 载荷与 SSE 快照;账号卡解释配额数字为何陈旧。
- **F4/续接保录**:driveSpan 在 finally 里基于已交付 tool-call 块决定 keep——预算截断/断连早断曾把生成器提前 finalize、遗忘 recording,404 掉客户端已收到的 mirror 续接。/code-review #9 补齐早断分支:续接 span 中早断曾用局部 `clientSawToolCall=false` 覆写首个 span 已记录的 keep 决策(重试同 mirror id 404 而非重放)→ OR-合并(完成时尾部覆写语义不变,早断只能放宽)。
- **ABORTED → 503**(#14):B3/P4 的 ABORTED 码此前不在两张 HTTP 表,落 500 默认;映射为 503 api_error(服务端主动放弃,无可预告的 Retry-After)。
- **管理密码引导安全**(#7/#13):SELECT 失败曾被当作首启、`INSERT OR REPLACE` 无声轮换既有 hash → 失败即 warn 返回(读不到就不猜);生成密码的"仅此一次"打印移到存储成功路径(失败时密码从未入库,打印只会误导)。
- **config 层修**(#8/#15):overrides 层 shutdownGraceMs 补齐 env 层同款 ≥1s 拒绝谓词(曾接受任意有限数);base memo 曾把 stat 失败但读取成功的奇异 Windows ACE 场景钉在常量键上 → 仅在真实 stat 身份上记忆。
- **主密钥 sidecar 响亮失败**(#3):现存 sidecar 损坏/不可读曾被无声再生成——孤儿化 DB 内全部 AES 密文(reveal/rotate 永久失读)而启动看起来健康 → 仅 ENOENT 生成,其余 throw;生成改 tmp+rename 原子写(0o600),撕裂半写不再可能冒充有效密钥。
- **限额校验**(#4 服务端 / #4 客户端):POST/PATCH /admin/keys 只查 isFinite,负数直达 `positiveIntOrZero`(负→0=无限额,一次笔误的静默放权)、小数被 floor → 非 0 非负整数一律 400;0 保持合法。WebUI 编辑/创建守卫镜像同一谓词,invalidLimit 文案收紧为「非负整数」。
- **quota 可观测**(#6):lastErrors 挂在合并池快照里,但 SSE 只由 pool.onChange 驱动——端点失败曾不可见,直到某次无关池变更碰巧推送 → QuotaService 加 onChange 接缝,index.ts 并联到 bus(250ms 去抖合并)。
- **配额周期单飞**(#11):布尔守卫静默丢弃重叠调用,手动刷新曾得到 ok:true 却对应一个尚未触达该池的周期 → promise 单飞(重叠者骑在飞周期;force 调用者收敛为一轮额外强刷;永不两周期并发)。
- **catalog 单飞**(#10):forceRefresh 绕过 `refreshing` 闩,手动刷新可与 poller 周期并发双 spawn `agy models` → 进闩,重叠 force 调用串行化;catalog-poller 注释从"overlap 安全"改为闩保证。
- **创建弹窗可逃逸**(#1):CreateKeyDialog 表单阶段携带 reveal 相位的 dismiss 守卫(saved 恒 false),Esc/外点被 preventDefault——唯一出路是提交创建 → 守卫仅在 reveal 相位铺开(RotateDialog 保持恒守卫:其整体即 reveal 步)。
- **持久化鲁棒(S4+S5)**:pool.json 加载失败隔离 `.corrupt-<ts>` 后按默认空态重建(保留证据,不再无声丢弃);token 刷新失败 unlink tmp(无 .tmp 残渣);teardown 补 sessions flush(500ms 去抖窗口内的绑定持久化曾可丢)。
- **RunRegistry 动态容量(S6)**:容量改 supplier(`max(8, maxConcurrent+2)`),hot-raising maxConcurrent 不再驱逐在飞 recording(mirror 续接 404 窗口);驱逐优先 settled-no-continuation > kept-for-continuation > unsettled(末位仍可驱逐,A-M4 最老优先保持)。
- **usage 保留接线(S8)**:types/ledger 于 B3 先行落地保持树自洽,B4 端到端接上(默认 0 行为不变)。

### Tests

- fake-agy 新模式:FAKE_AGY_ENV_FILE env 白名单录制;新测试面:semaphore 重写套件(parking abort 无残留、handoff 后 abort 无操作、400-op 随机混沌)、engine 守卫(settle 失败终帧路径)、shutdown-sse(preClose 落盘)、m0(S2 层叠 + 钳制、启动分类 spawn-free)、ledger 缓存翻转/播种、config memo、discovery/models-catalog/catalog-poller/admin-catalog、admin-session 引导 6 例;0.2.0 的 458 → 562 tests / 55 files。
- CI 触碰时钟钉死:去抖测试两次 touch 在 CI 快机上同落一毫秒,buffer 进 pending 的是首次写入的同一时间戳,flush 断言翻红 → 第二次 touch 的时钟 scoped 钉到 first+1s(仍在 60s 窗口内,去抖分支照旧覆盖);产品代码未动。

### Ops

- Dockerfile 3 阶段(build 期工具链 + better-sqlite3 绑定闸),tini PID 1,agy CLI pin `1.1.22` 不变(升级视为独立变更,charter §4)。
- compose:镜像默认 `ghcr.io/sakiko15/agy-proxy:0.3.0`,`stop_grace_period: 40s`,日志轮转,`init: false` 保持;内存建议见 docs/deploy.md 5.2。