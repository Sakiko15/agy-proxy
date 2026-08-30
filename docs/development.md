# agy-proxy 开发流程

版本 v0.1（2026-08-30）· 配套文档：[charter.md](./charter.md)、[acceptance.md](./acceptance.md)

轻量流程，单人 + AI 协作开发。原则：**流程只保留能防真实事故的条款**。

## 1. 仓库与目录约定

- Monorepo 布局：`src/`（服务端 TS ESM）、`web/`（React 前端，独立构建）、`test/`（vitest）、`docs/`
- 包管理 npm（`package-lock.json` 唯一锁文件，不用 pnpm/yarn 混用）
- 新仓库根放置 `CLAUDE.md`（供 AI 会话使用，从 charter/acceptance 提炼要点 + 本文件链接）

## 2. 分支与提交

- 主分支 `main`；功能分支 `feat/<slug>`、修复 `fix/<slug>`、移植 `port/<module>`
- commit 格式沿用 dsh-agy-link 风格：`feat(engine): ...`、`fix(openai): ...`、`port: bring parser/runner verbatim from dsh-agy-link@<sha>`
- **移植类提交必须注明来源模块与源仓库 commit sha**，原样移植的文件不得混入功能性改动（保持与上游可 diff）；需要改造时拆成两个提交：先原样移植，再改造
- 一个 commit 一个意图；禁止在功能提交里夹带格式化/重构

## 3. CI 三闸（每个 PR 必须全绿）

1. `npm run check` — tsc --noEmit（strict）
2. `npm run build` — 服务端 tsdown + 前端 vite build
3. `npm test` — vitest run（含 fake-agy 集成测试）

CI 中 build 先于 test（集成测试可能引用构建产物），与 dsh-agy-link 同款教训。GitHub Actions 单 job ubuntu-latest + node 24 即可，不搞矩阵。

## 4. PR 完成定义（DoD）

- 新功能必须带测试：协议适配层改动 → golden 用例更新并说明理由（见 acceptance.md §2）；引擎层改动 → fake-agy 新场景或单测；错误路径必须有对应测试
- 涉及协议字段的改动，PR 描述里附"字段映射变化"小节
- 涉及 §10（charter）安全面的改动（鉴权/密钥/权限模式/日志脱敏），PR 描述必须显式声明安全影响
- 自查清单：无 console.log 残留、无未捕获 promise、新环境变量已登记到 config 层与 README 配置表

## 5. 测试纪律

- fake-agy 桩（继承 dsh-agy-link 思路）：新增上游行为认知（新事件形状、新错误文本）时，先加 fake-agy 模式再写引擎处理，形成"官方文档/抓包 → 桩 → 实现 → 断言"闭环
- SSE 断言解析事件序列与字段，不断言原始字节（见 acceptance.md §2）
- 禁止 mock 掉被测对象本身；协议适配层测试用 golden JSON，不用快照工具的自动快照（人工审阅 diff）

## 6. 版本与发布纪律

- 版本号 semver；`CHANGELOG.md` 每个版本强制条目（含根因说明，继承 dsh-agy-link 风格）
- **禁止自动发布**：npm publish / GitHub Release / 打 tag 必须等待用户在会话中显式下达指令（"发布"、"release"）。此前状态：三闸全绿 + CHANGELOG 已更新 + 版本号已 bump + 变更摘要已呈现
- Docker 镜像 tag 与 git tag 一一对应；`latest` 仅指向最新稳定版
- agy 上游版本升级视为独立变更：升级前跑全套协议回归（charter §4 矩阵），PR 单列

## 7. 移植与上游同步

- dsh-agy-link 是活的上游：其引擎层修复（parser/runner/pool 等）应有选择地跟进
- 移植文件头部加注释标记：`// ported from dsh-agy-link <path> @ <sha> (verbatim)` 或 `(modified: <改动摘要>)`
- 同步上游修复时，只取修复本身，重新走本文件 §3/§4

## 8. 安全红线（任何开发阶段不可违反）

- 日志/错误信息/doctor 输出中不得出现：API key 明文、OAuth token、授权码、Bearer 头（脱敏函数统一处理，新日志点必须过它）
- 禁止实现任何 token 导出/导入功能（charter §10 上游纪律）
- `--dangerously-skip-permissions` 相关代码路径默认值必须为关闭；改动其默认值需要独立 PR 并在描述中高亮
- 依赖新增需说明用途；禁止引入带运行时遥测的库

## 9. AI 协作约定

- 立项文档（charter.md）是事实来源：实现与 charter 冲突时，改 charter 并说明理由，或改实现——不允许两处漂移
- 每个里程碑开工前，先读 acceptance.md 对应章节，把 DoD 转成任务清单
- 验收测试失败时优先怀疑实现而非测试；修改验收用例必须给出协议文档依据
