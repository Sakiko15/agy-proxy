# 部署 runbook — VPS + docker + 反向代理（M5）

目标形态：一台 VPS，docker 运行 `agy-proxy`，前置反向代理（nginx / Caddy / Cloudflare）终结 TLS 并转发 SSE。本文是 `docs/acceptance.md` §3 M5 DoD 的操作面：compose 部署步骤、首启密码、SSE 关键配置、以及 docker 版强杀演练（对应 `docs/verify/m5.md` P3 的容器腿，待用户在 VPS 执行）。

红线提醒（development.md §6）：**tag / GitHub Release / 镜像推送一律等待用户显式发布指令**；本文只描述部署流程，不含发布动作。

## 1. 两种部署路径

**A. 从 checkout 构建（推荐先行）**

```bash
git clone <repo> agy-proxy && cd agy-proxy
npm ci && npm run build        # tsdown + web 构建链
docker compose up -d --build   # 使用 compose 中的 `build: .`（需先取消注释）
```

**B. 拉取预构建镜像**

`docker-compose.yml` 中的 `image: ghcr.io/OWNER/agy-proxy:latest` 是占位符：把 OWNER 换成实际 push 目标（或用 `.env` 覆盖），再 `docker compose up -d`。在用户下达发布指令之前，该镜像**不存在于任何 registry** —— 先用路径 A。

agy CLI 版本由 Dockerfile `ARG AGY_CLI_VERSION=1.1.22` 锁定（m1.md 真机记录）；如需更换请显式覆盖 build args 并重跑全套协议回归（charter §4 矩阵）。

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
docker run --rm -v agy-data:/data -v $PWD:/bak alpine \
  tar czf /bak/agy-data-$(date +%F).tar.gz -C /data .
```

恢复 = 停容器 → 清空卷 → 解包 → 起服。卷内所有凭证 device-bound，**跨机器迁移等于重新登录**（换机后每个账号需重跑 admin UI 的 login 流程）。

## 6. 日志与观测面速查

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `AGY_PROXY_DEBUG_METRICS_MS` | `0` | 每 N ms 输出一行 NDJSON `{"debug":"metrics", rss, handles, uptime}`（soak 采样） |
| `AGY_PROXY_LOG_LEVEL` | `info` | pino 级别 |
| `AGY_PROXY_SSE_HEARTBEAT_MS` | `60000` | 引擎静默时保活心跳；代理必配项之一 |