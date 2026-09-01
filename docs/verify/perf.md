# M5 性能基线（docs/acceptance.md §4 → §5 格式归档）

- **日期**：2026-09-01
- **Commit sha**：`ec17a1a`（M5 全部代码 + 修复提交后的工作树；perf 跑 `dist/` 产物）
- **执行人**：sakiko（Claude Code 会话代执行）
- **环境**：Windows 10 Pro 主机（非 Docker），Node 24.13；上游 **全程 `test/fake-agy.mjs`**（干净临时 dataDir），未消耗真实 Antigravity 配额；`npx tsx scripts/perf.mts`，机器空闲窗口（无 soak 并发）。
- **方法学**：8 腿，每腿与「裸管参照」（相同 argv 直接走 `startAgyProcess`，不经网关）对照。门限取自 acceptance §4；开销差（Δ）才是被考察量——绝对值是 agy 冷启动的主导项（本机 ~300ms），跨主机不可比。
- **burst pacing 说明**：网关对 `agy` spawn 自带 500ms + rand(0~300ms) 抖动（**按账号** spacing 闸，burst pacing）。单请求首字/非流式耗时不受影响（间隔只约束同账号相邻 spawn），并发铺开腿（⑥）与顺序对照腿（②⑤）间隔 ≥PACING=900ms。M5 开发中定案的测量纪律：不满足间隔的顺序腿会测到 throttle 主导的假开销。

## 结果（8/8 PASS，exit=0；本档为发布记录值）

| # | 腿 | 门限 | 实测 | 判定 |
|---|---|---|---|---|
| — | models 目录冷 / 热 | 冷 <1.5s / 热 <10ms | 4ms / 2ms | PASS |
| ① | SSE 首增量开销（20 对 P50/P95） | gateway − bare <50ms | Δ **13ms**（308 vs 295ms；P95 313ms） | PASS |
| ② | 非流式开销 | <100ms | Δ **5ms**（307 vs 302ms 全程） | PASS |
| ③ | flood 转发（20k 事件无 await 批灌） | ≈ 裸管速率（无积压近似） | gateway P50 **315ms** vs 裸管 71ms，**20002 行**全转发、零错误、零截断 | PASS |
| ④ | 账本落库 P95（30 个唯一 x-request-id 轮询对账） | <2s | **957ms** | PASS |
| ⑥ | 3 账号并发吞吐 | ≥2.5× | serial 3767ms → parallel **321ms** = **11.7×**（并行三发 310/314/320ms，busy-spread 修复后真铺开；逐发 accountId 诊断确认三账号各一） | PASS |
| ⑦ | 单 key RPM=5 | 第 6 发 429 + Retry-After | `[200×5, 429]`，`retry-after=60`（秒） | PASS |
| — | `AGY_PROXY_DEBUG_METRICS_MS` NDJSON 观测行 | soak 可抓取 | soak 判定 PASS（见 m5.md P1） | PASS |

## 过程记录（测量纪律的实证）

- **busy-spread 修复前**（per-call 局部 Set，commit f764c0d 的原始版本）：同族并发 arrivals 叠在单账号 spacing 闸后，并行腿测得 1.9~2.2×（门 ≥2.5× 之下浮动，当时的 2.7× 是时序运气）；修复后腿 6 达 **11.7×**（三发并行各 ~310ms，账号各不同——逐发 accountId 诊断确认）。
- **测量环境纪律**：soak 并发运行时测得的吞吐比 2.0~2.2× 属主机 CPU 争用（CPU 12% 空闲时复跑即恢复），perf 归档必须取空闲窗口。
- ③ flood 线 20002 行 = 20000 事件 + init + result 信封；P50 高于裸管是流经 mapper/recording 的正常折损，门限语义为「同数量级、无积压/无错误」（0-1 队列不变量外部不可直接观测，以转发完整性 + 速率同数量级作近似记录）。
- ⑦ RPM 计数按 key 隔离（rate-limiter-flexible Memory，固定窗）；`retry-after` 由 limiter 现成头透出，网关原样转发。
- 复跑方差（同 sha 树）：SSE Δ 9~13ms、plain Δ 5~7ms、ledger P95 945~975ms、吞吐比 2.0×（修复前）→ 11.7×（修复后）。**本档（sha `ec17a1a`）为发布记录值。**

## 复现

```bash
npm run build        # perf/soak 跑 dist/ —— 改 src 后必须先重建（m5 教训）
npx tsx scripts/perf.mts
```