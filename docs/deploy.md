# 部署 runbook — VPS + docker + 反向代理（M5）

目标形态：一台 VPS，docker 运行 `agy-proxy`，前置反向代理（nginx / Caddy / Cloudflare）终结 TLS 并转发 SSE。本文是 `docs/acceptance.md` §3 M5 DoD 的操作面：compose 部署步骤、首启密码、SSE 关键配置、以及 docker 版强杀演练（对应 `docs/verify/m5.md` P3 的容器腿，待用户在 VPS 执行）。

红线提醒（development.md §6）：**tag / GitHub Release / 镜像推送一律等待用户显式发布指令**；本文只描述部署流程，不含发布动作。

## 1. 部署路径

**A. 从 checkout 构建（自包含，无本机 Node 也能做）**

```bash
git clone https://github.com/Sakiko15/agy-proxy.git agy-proxy && cd agy-proxy
docker build -t agy-proxy:local .   # Dockerfile stage 0 在容器内编译网关 bundle
AGY_PROXY_IMAGE=agy-proxy:local docker compose up -d
```

**B. 拉取预构建镜像（主 registry = Docker Hub，已发布）**

compose 的 `image` 行已内置默认 `docker.io/sakiko15/agy-proxy:0.2.0`（仍可用 `.env` 的 `AGY_PROXY_IMAGE` 覆盖）。镜像由 GitHub Actions 的 `docker-release` workflow（手动 dispatch，版本入参）构建推送，tag 为 `<version>` + `latest`（linux/amd64）。若 Docker Hub 仓库设为私有，需先配认证（1Panel「容器 → 仓库」或 `docker login`）。ghcr.io 仅作备选（CN VPS 可达性通常差于 Docker Hub）。

**C. 1Panel 面板编排 + 远程拉取镜像（本文实际部署形态）** —— 见 §1.1。

agy CLI 版本由 Dockerfile `ARG AGY_CLI_VERSION=1.1.22` 锁定（m1.md 真机记录）；如需更换请显式覆盖 build args 并重跑全套协议回归（charter §4 矩阵）。

### 1.1 路径 C：1Panel 编排（远程拉取镜像）

已核实的面板事实（[1Panel 编排官方文档](https://1panel.cn/docs/v1/user_manual/containers/compose/)）：创建编排支持「编辑 / 路径选择 / 编排模版」三种来源；**编辑与启停操作仅适用于 1Panel 创建的编排**；编排文件落在 `{安装目录}/1panel/docker/compose/<名称>/`（项目名即编排名）。

1. **镜像就位**：GitHub 仓库 Actions 页 → `docker-release` → Run workflow（版本入参与 `package.json` 一致，当前 `0.2.0`）→ 等待构建推送完成；若 Docker Hub 仓库设为私有，先在 1Panel「容器 → 仓库」添加仓库并填凭据（Docker Hub 账号 / token），否则拉取 401。
2. **面板创建编排**：1Panel → 容器 → 编排 → 创建编排 → 来源「编辑」→ 文件夹名称填 `agy-proxy` → 粘贴仓库的 `docker-compose.yml` → 确认创建（`image` 默认 `docker.io/sakiko15/agy-proxy:0.2.0`，无需 .env；要覆盖镜像或设 `AGY_PROXY_API_KEY` 时才放 `.env`）。
3. **首启密码**：编排详情 → 容器 → 日志（或 SSH 后 `docker logs agy-proxy | grep -i password`）——随机管理密码只打印一次；常驻部署建议直接设 `AGY_PROXY_ADMIN_PASSWORD`（env）。
4. **镜像加速**（CN VPS）：拉 Docker Hub 慢/失败时，1Panel「容器 → 配置 → 镜像加速」或 `/etc/docker/daemon.json` 配 registry-mirrors。
5. 编排卷名带项目前缀：备份命令（本文 §5）中 `-v agy-data:/data` 对应改为实际卷名 `<编排名>_agy-data`（`docker volume ls | grep agy-data` 确认）。

**暂不配反向代理的安全边界（当前实际形态）**

- compose 默认只绑 `127.0.0.1:8080`——管理面（`/admin/*`）与 `/v1` 在隧道外**不可达**；访问 WebUI 走 SSH 隧道：`ssh -L 8080:127.0.0.1:8080 <vps>` 后本机开 `http://127.0.0.1:8080`。
- 全程无 TLS：任何经公网直发的流量都是明文。在接反代（OpenResty/Caddy/nginx 任一）之前，不要把端口改为 `0.0.0.0` 或 `8080:8080` 全开。
- `AGY_PROXY_ADMIN_ALLOW_CIDR` 填实际 docker 网段 + `127.0.0.1/32`（compose 注释示例，按请求重读）；对外 `/v1` 服务在接反代前同样只面向本机。

**强杀演练 / 长稳的 1Panel 等价操作**（对映 `docs/verify/m5.md` P3 与用户执行项）：面板「容器」页可直接看日志 / 强制停止（= `docker kill`，强杀腿等价）/ 重建（等价 compose 重启）；本文件 §4 的 docker CLI 步骤在面板编排下同样适用（1Panel 编排就是标准 compose 项目）。

**预留：接 1Panel OpenResty 反代时**（启用 SSE 对外服务时再做）：compose 取消 `1panel-network` 注释（外部网络，与面板 OpenResty 同网络后代理地址写 `http://agy-proxy:8080`，无需宿主端口）；网站 → 目标域名 → 配置 → 配置文件，在反代 location 内加 SSE 三件套——`proxy_buffering off;`（逐 chunk 直通）+ `proxy_http_version 1.1; proxy_set_header Connection '';` + `proxy_read_timeout 3600s;`——并把代理侧 IP/CIDR 填进 `AGY_PROXY_TRUSTED_PROXIES`（真实客户端地址决定 admin-CIDR 判定）。

## 2. 首次启动与首启密码

```bash
AGY_PROXY_API_KEY=$(openssl rand -hex 24) docker compose up -d
docker logs agy-proxy | grep -i password   # 首启随机管理密码只打印一次
```

- `AGY_PROXY_ADMIN_PASSWORD`（env）优先于存储哈希，boot 时重哈希；env 常驻部署建议直接设置，避免依赖一次性打印。
- 首次登录：`http://<vps>/login`（或在代理上只暴露 `127.0.0.1` 的后端 + 你自建的 TLS 站点）。
- 管理面默认允许任意来源 CIDR —— **必须在 compose 注释处设置 `AGY_PROXY_ADMIN_ALLOW_CIDR`**（例如代理网段 + 本机回环），守卫链 CIDR 按请求重读。

## 3. 反向代理配置（SSE 必需项）

流式响应依赖长连接与逐 chunk 冲刷；以下配置任一缺失都会把 SSE 退化为"转完才吐"或被中间层掐断。

### nginx

```nginx
server {
    listen 443 ssl http2;
    server_name agy.example.com;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        # --- SSE 三件套 ---
        proxy_buffering off;      # 逐 chunk 直通（默认 on 会攒满缓冲才发）
        proxy_cache off;
        proxy_read_timeout 3600s; # 长流式回合 + 工具轮转不止数分钟
        proxy_send_timeout 3600s;
        client_max_body_size 32m; # 多模态图片上行（mediaMaxBytes × N + JSON）
    }
}
```

**Caddy**（默认即按需冲刷，显式声明更稳）：

```caddy
agy.example.com {
    reverse_proxy 127.0.0.1:8080 {
        flush_interval -1          # 立即冲刷每个 chunk（-1 = 禁用缓冲）
        transport http {
            read_timeout 0         # 长连接不被断
            response_header_timeout 0
        }
        request_body {
            max_size 32MB
        }
    }
}
```

**Cloudflare 前置**：SSE 走 CF 时务必确认对 `/v1/*` 与 `/admin/events` 关闭缓存/性能优化，并保持 `AGY_PROXY_SSE_HEARTBEAT_MS`（默认 60000）开启 —— 橙云代理会掐 100s 静默连接。

**真实客户端地址**：网关按请求读 CIDR 白名单；若代理转发 `X-Forwarded-For`，需在网关环境设置 `AGY_PROXY_TRUSTED_PROXIES=<代理 IP/CIDR>`（逗号分隔），否则以 TCP 对端为准。

## 4. 强杀演练（docker 版，待用户在 VPS 执行）

对映 `docs/verify/m5.md` 的 P3（本机 taskkill /T /F 腿已在假上游跑通）。容器版步骤：

```bash
# 基线：写入 3 个独特 x-request-id 的请求（fake 上游或真实账号均可）
for i in 1 2 3; do
  curl -s -X POST http://127.0.0.1:8080/v1/chat/completions \
    -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
    -H "x-request-id: kill-drill-$i" \
    -d '{"model":"gemini-3-6-flash","stream":false,"messages":[{"role":"user","content":"drill"}]}'
done
docker exec agy-proxy node -e "console.log(require('better-sqlite3')('/data/agy-proxy.db').prepare('SELECT COUNT(*) n FROM usage').get().n)"

docker kill agy-proxy                     # SIGKILL 容器（等价容器内 taskkill /T /F 树杀）
docker compose up -d
sleep 3
curl -s http://127.0.0.1:8080/healthz
docker exec agy-proxy node -e "console.log(require('better-sqlite3')('/data/agy-proxy.db').prepare('SELECT COUNT(*) n FROM usage').get().n)"
# 判定（重复 ×3 个周期）：healthz 绿 + usage 行数逐周期 +1；三次强杀后总数 3 完好。
# WAL+FULL 下 SIGKILL 至多丢最后一个 flush 窗口的行（charter §6 crash-recovery）。
```

同时记录：`docker inspect --format='{{.State.OOMKilled}} {{.State.Restarting}}' agy-proxy`（应 false），以及 `docker logs | grep -c '"debug":"metrics"'`（句柄回归的进程内读数）。

## 5. 卷备份

```bash
docker volume ls | grep agy-data        # 1Panel 编排下卷名为 <编排名>_agy-data，以下命令用实际卷名
docker run --rm -v <实际卷名>:/data -v $PWD:/bak alpine \
  tar czf /bak/agy-data-$(date +%F).tar.gz -C /data .
```

恢复 = 停容器（1Panel：编排停止）→ 清空卷 → 解包 → 起服。卷内所有凭证 device-bound，**跨机器迁移等于重新登录**（换机后每个账号需重跑 admin UI 的 login 流程）。

## 5.1 日界时区（S-M9）

per-key 每日 token 预算按**容器本地午夜**切日（`startOfToday` 用 `setHours(0,0,0,0)`
取本地零点时间戳，见 `src/server/usage-ledger.ts`）。基础镜像未设 `TZ`，即 **UTC** ——
对 UTC+8 运营者，实际切日是北京时间早上 8 点（前一日预算覆盖到 8:00）。
需按本地日切日时，在 compose 的 `environment` 中加（docker-compose.yml 已留注释行）：

```yaml
    environment:
      TZ: "Asia/Shanghai"
```

仅影响记账/展示的日界与日期串，不改变任何网关语义；已产生的 usage 行不会回溯重算。

## 6. 日志与观测面速查

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `AGY_PROXY_DEBUG_METRICS_MS` | `0` | 每 N ms 输出一行 NDJSON `{"debug":"metrics", rss, handles, uptime}`（soak 采样） |
| `AGY_PROXY_LOG_LEVEL` | `info` | pino 级别 |
| `AGY_PROXY_SSE_HEARTBEAT_MS` | `60000` | 引擎静默时保活心跳；代理必配项之一 |