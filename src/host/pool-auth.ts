// PoolAuthFlow: self-owned Google OAuth lifecycle for adding pool accounts.
//
// Flow: create staging slot -> PKCE authorize URL -> loopback callback
// listener + server-side browser open -> automatic code capture ->
// exchange -> write agy-format token file into the staging HOME -> verify
// via fetchAvailableModels/userinfo -> commit into the pool. Manual code
// (or redirect URL) paste is the fallback when the listener cannot bind.
// Ported from dsh-agy-link src/host/pool-auth.ts @ 46984db (modified:
// beginPrimary() and the primary/system-HOME branch removed — the gateway
// always runs headless and every account gets an isolated staging HOME).
import { randomBytes } from 'node:crypto'
import {
  buildAuthorizeUrl,
  exchangeCode,
  fetchUserEmail,
  generatePkce,
  openBrowser,
  parsePastedCode,
  startCallbackListener,
  writeAgyTokenFile,
  type CallbackHandle,
} from './oauth.ts'
import type { AccountPoolManager } from './pool.ts'
import type { QuotaService } from './quota.ts'

export type PoolAuthPhase = 'idle' | 'waiting' | 'exchanging' | 'done' | 'failed'

export interface PoolAuthStatus {
  phase: PoolAuthPhase
  stagingId?: string
  alias?: string
  url?: string
  /** 'auto' = loopback listener live; 'manual' = paste the code/URL back. */
  mode?: 'auto' | 'manual'
  browserOpened?: boolean
  message?: string
}

interface ActiveFlow {
  stagingId: string
  dir: string
  alias?: string
  proxyUrl?: string
  verifier: string
  state: string
  url: string
  mode: 'auto' | 'manual'
  listener: CallbackHandle | null
}

const DONE_STATUS_TTL_MS = 30_000

export interface PoolAuthFlowDeps {
  /** Injectable for tests; defaults to the OS browser open. */
  openBrowser?: (url: string) => Promise<boolean>
}

export class PoolAuthFlow {
  private flow: ActiveFlow | null = null
  private statusValue: PoolAuthStatus = { phase: 'idle' }
  private doneResetTimer: NodeJS.Timeout | null = null
  private readonly open: (url: string) => Promise<boolean>

  constructor(
    private readonly pool: AccountPoolManager,
    private readonly quota: QuotaService,
    private readonly log: (msg: string) => void = () => {},
    deps: PoolAuthFlowDeps = {},
  ) {
    this.open = deps.openBrowser ?? openBrowser
  }

  status(): PoolAuthStatus {
    return { ...this.statusValue }
  }

  private setStatus(patch: Partial<PoolAuthStatus> & { phase: PoolAuthPhase }): void {
    if (this.doneResetTimer) {
      clearTimeout(this.doneResetTimer)
      this.doneResetTimer = null
    }
    this.statusValue = { ...this.statusValue, ...patch }
    if (patch.phase === 'done') {
      // Hold the success state briefly so pollers see it, then reset.
      this.doneResetTimer = setTimeout(() => {
        if (this.statusValue.phase === 'done') this.statusValue = { phase: 'idle' }
      }, DONE_STATUS_TTL_MS)
    }
  }

  /**
   * Shared starter: PKCE + loopback listener + server-side browser open.
   * Never reports success without a URL; bind failure degrades to manual
   * paste mode instead of pretending the browser opened.
   */
  private async startFlow(flow: Omit<ActiveFlow, 'verifier' | 'state' | 'url' | 'mode' | 'listener'>): Promise<PoolAuthStatus & { ok: boolean; dir?: string }> {
    await this.abortActive()

    const { verifier, challenge } = generatePkce()
    const state = randomBytes(16).toString('base64url')
    const url = buildAuthorizeUrl(challenge, state)

    // startCallbackListener signals bind errors by rejecting `result`;
    // give the listener one tick to bind before declaring auto mode.
    let listener: CallbackHandle | null = startCallbackListener()
    let bindFailed = false
    await Promise.race([
      listener.result.then(
        () => {},
        () => {
          bindFailed = true
        },
      ),
      new Promise((resolve) => setTimeout(resolve, 300)),
    ])
    if (bindFailed) {
      await listener.close().catch(() => undefined)
      listener = null
    }
    const mode: 'auto' | 'manual' = listener ? 'auto' : 'manual'

    const browserOpened = await this.open(url)

    const active: ActiveFlow = { ...flow, verifier, state, url, mode, listener }
    this.flow = active
    this.setStatus({
      phase: 'waiting',
      stagingId: active.stagingId,
      alias: active.alias,
      url,
      mode,
      browserOpened,
      message: browserOpened
        ? undefined
        : '无法自动打开浏览器，请手动打开下方链接',
    })
    this.log(`pool auth begun (${mode} mode, browserOpened=${browserOpened})`)

    if (listener) {
      void listener.result
        .then(({ code, state: returnedState }) => this.finishWithCode(code, returnedState))
        .catch((err: unknown) => {
          if (!this.flow || this.flow.listener !== listener) return
          this.fail(`授权回调失败: ${err instanceof Error ? err.message : String(err)}`)
        })
    }

    return { ok: true, ...this.statusValue, dir: active.dir }
  }

  /** Begin adding a pool account (isolated staging HOME). */
  async begin(alias?: string, proxyUrl?: string): Promise<PoolAuthStatus & { ok: boolean; dir?: string }> {
    const staging = this.pool.createStagingSlot()
    return this.startFlow({ stagingId: staging.id, dir: staging.dir, alias, proxyUrl })
  }

  /** Manual paste fallback: accepts a bare code or the full redirect URL. */
  async submitCode(input: string): Promise<PoolAuthStatus & { ok: boolean }> {
    const flow = this.flow
    if (!flow || this.statusValue.phase !== 'waiting') {
      return { ok: false, phase: this.statusValue.phase, message: '当前没有进行中的授权流程' }
    }
    const parsed = parsePastedCode(input)
    if (!parsed) {
      return { ok: false, phase: 'waiting', message: '无法识别的授权码，请粘贴授权码或完整的回调 URL' }
    }
    if (parsed.state && parsed.state !== flow.state) {
      return { ok: false, phase: 'waiting', message: 'state 校验失败：这段 URL 不属于本次授权流程' }
    }
    await this.finishWithCode(parsed.code, parsed.state ?? flow.state)
    const after = this.status()
    return { ...after, ok: after.phase === 'done' }
  }

  private async finishWithCode(code: string, returnedState: string): Promise<void> {
    const flow = this.flow
    if (!flow || this.statusValue.phase !== 'waiting') return
    if (returnedState !== flow.state) {
      this.fail('state 校验失败（可能的 CSRF 或过期回调）')
      return
    }
    this.setStatus({ phase: 'exchanging' })
    try {
      const tokens = await exchangeCode(code, flow.verifier, flow.proxyUrl)
      writeAgyTokenFile(flow.dir, tokens)
      const email = await fetchUserEmail(tokens.access_token, flow.proxyUrl)
      const acc = this.pool.commitStagingAccount(flow.stagingId, flow.dir, flow.alias, email, flow.proxyUrl)
      this.log(`pool auth committed account ${acc.id}${email ? ` <${email}>` : ''}`)
      // Quota refresh is best-effort; the account is usable regardless.
      void this.quota.refreshAccountQuota(acc).catch(() => undefined)
      this.flow = null
      if (flow.listener) void flow.listener.close().catch(() => undefined)
      this.setStatus({ phase: 'done', alias: acc.alias, message: `账号 ${acc.alias} 已激活` })
    } catch (err) {
      this.fail(`授权码交换失败: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  private fail(message: string): void {
    const flow = this.flow
    this.log('pool auth failed: ' + message)
    if (flow) {
      if (flow.listener) void flow.listener.close().catch(() => undefined)
      this.pool.cleanupStagingSlot(flow.dir)
      this.flow = null
    }
    this.setStatus({ phase: 'failed', message })
  }

  async cancel(): Promise<PoolAuthStatus & { ok: boolean }> {
    await this.abortActive()
    this.setStatus({ phase: 'idle' })
    return { ok: true, phase: 'idle' }
  }

  private async abortActive(): Promise<void> {
    const flow = this.flow
    if (!flow) return
    this.flow = null
    if (flow.listener) await flow.listener.close().catch(() => undefined)
    this.pool.cleanupStagingSlot(flow.dir)
  }
}
