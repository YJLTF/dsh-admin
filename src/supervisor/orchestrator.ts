/**
 * 每用户 DSH 进程管理器：一个常驻主 DSH 加一个**按需**看门狗。
 *
 * 看门狗并不在启动时拉起；只在主 DSH 崩溃（需要修复）或需要执行
 * 重启后命令时拉起一次。这样活跃用户的常态足迹是每用户一个进程，
 * 同时仍能提供崩溃修复 + 命令交接。看门狗 agent 级的修复/会话续接
 * 属于 harness 内部机制，推迟到与真实 harness 集成时实现
 * （见 docs/blueprint.md §4）。
 * @module dsh-admin/supervisor/orchestrator
 */

import { spawn, type ChildProcess, type StdioOptions } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { networkInterfaces } from 'node:os'
import { connect } from 'node:net'
import { join } from 'node:path'
import type { Server as HttpServer } from 'node:http'
import type { ServerConfig } from '../config.js'
import { uidForUser } from '../isolation.js'
import { MAIN_PROFILE } from '../fs/plugins.js'
import { userHomeDir, workspaceRoot } from '../fs/workspace.js'
import { startForwarder, probeIndex } from './forwarder.js'
import { createPortGuard, type PortGuard } from './firewall.js'
import { findFreePort, scrubEnv } from './spawn.js'

export type InstanceStatus = 'starting' | 'running' | 'crashed' | 'stopped'
export type InstanceRole = 'main' | 'watchdog'

/** 交给一次性无头看门狗的任务，避免其因缺少任务而报错；
 * 执行交接路径中任何重启后命令。 */
const WATCHDOG_TASK = '读取 DSH_ADMIN_HANDOFF_PATH。若其中包含 JSON {"command": ...}，则运行该命令。然后退出。'

/** 被跟踪的子 DSH（主或看门狗）。 */
export interface Instance {
  id: string
  userId: string
  role: InstanceRole
  folder: string
  port?: number
  status: InstanceStatus
  pid?: number
  startedAt: number
  exitCode?: number
  lastError?: string
  patchPath?: string
  /** 连续自动重启次数；就绪成功或手动（重）启动时归零。供熔断与展示。 */
  restarts?: number
  /** 内网模式下转发器的访问令牌；随每次（重）拉起轮换。
   * 仅通过已认证的 API（launch/restart/status 返回的 url）交付给属主。 */
  token?: string
  /** 子 DSH web 自己的浏览器认证 launchToken —— 从子进程 stdout 的
   * `dsh web: …?token=…` 行捕获（dsh ≥0.1.2-alpha.5 的首页强制此门）。
   * 打印晚于端口就绪，捕获是异步 best-effort；转发器用它把通过自身
   * 令牌门的首导航交接给 DSH，换取浏览器侧的会话 cookie。 */
  launchToken?: string
}

/** 管理台全局实例视图的单行快照。 */
export interface InstanceSummary {
  userId: string
  role: InstanceRole
  status: InstanceStatus
  port?: number
  pid?: number
  startedAt: number
  restarts: number
  lastError?: string
}

/** 就绪探测参数：间隔与最长探测时长（超时后保持 starting，
 * 不臆造崩溃 —— 进程活着但未监听是可见的、可停止的状态）。 */
const READY_PROBE_INTERVAL_MS = 150
const READY_PROBE_TIMEOUT_MS = 60_000
/** 单次连接探测的挂起上限（超出按未就绪处理，防止轮询循环卡死）。 */
const READY_PROBE_CONNECT_TIMEOUT_MS = 2_000

/** 子进程的环回监听是否已接受 TCP 连接（握手成功即就绪）。 */
function probePort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port })
    const done = (ok: boolean): void => {
      socket.destroy()
      resolve(ok)
    }
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
    // 过滤型防火墙规则可能让 SYN 无响应地挂起；超时按未就绪处理，
    // 交回轮询循环（整体仍受 READY_PROBE_TIMEOUT_MS 约束）。
    socket.setTimeout(READY_PROBE_CONNECT_TIMEOUT_MS, () => done(false))
  })
}

/** dsh CLI 版本探测的缓存窗口与单次探测超时。 */
const DSH_VERSION_TTL_MS = 60_000
const DSH_VERSION_TIMEOUT_MS = 4_000

/** 运行 `<dshCommand> --version` 并取首个非空行（stdout/stderr 合并）。
 * 退出码不敏感（老 CLI 可能以 usage 退出但仍打印版本）；无输出、启动
 * 失败（如 ENOENT）或超时都返回 null —— 版本未知不是服务器错误。 */
function probeDshVersion(command: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    const [cmd = 'dsh', ...prefix] = command
    let out = ''
    let done = false
    // 版本探测不经过 setuid 包装：读 --version 不触及任何用户资源。
    const child = spawn(cmd, [...prefix, '--version'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: scrubEnv(process.env),
    })
    const timer = setTimeout(() => child.kill('SIGKILL'), DSH_VERSION_TIMEOUT_MS)
    timer.unref()
    const finish = (): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      const line = out
        .split(/\r?\n/)
        .map((l) => l.trim())
        .find((l) => l !== '')
      resolve(line === undefined ? null : line.slice(0, 80))
    }
    child.stdout?.on('data', (chunk: Buffer) => {
      out += chunk.toString()
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      out += chunk.toString()
    })
    child.on('error', finish)
    child.on('close', finish)
  })
}

/** 当某用户已有一个运行中的主 DSH 时抛出。 */
export class AlreadyRunningError extends Error {
  constructor(userId: string) {
    super(`用户 ${userId} 已有一个运行中的 DSH`)
    this.name = 'AlreadyRunningError'
  }
}

/** 用户的主 + 看门狗进程对。 */
export interface UserStatus {
  main?: Instance
  watchdog?: Instance
}

/** 第一个非内部 IPv4（容器的 eth0），不存在时为 null。 */
function firstLanIpv4(): string | null {
  for (const ifaces of Object.values(networkInterfaces())) {
    for (const iface of ifaces ?? []) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address
    }
  }
  return null
}

/**
 * 持有每用户 DSH 进程对的生命周期。状态保存在内存中。
 */
export class Supervisor {
  private readonly mains = new Map<string, Instance>()
  private readonly watchdogs = new Map<string, Instance>()
  private readonly children = new Map<string, ChildProcess>()
  private readonly restartTimers = new Map<string, NodeJS.Timeout>()
  private readonly forwarders = new Map<string, HttpServer>()
  /** 缓存的非内部 IPv4（可发布网卡）；null = 无。 */
  private lanIp: string | null = null
  private readonly portGuard: PortGuard | undefined
  /** dsh CLI 版本探测结果缓存；null 值也缓存（二进制缺失时状态轮询
   * 不应每次都空跑一次探测）。 */
  private dshVersionCache: { value: string | null; at: number } | null = null
  /** 进行中的版本探测（并发去重：同时到达的多个请求共享一次探测）。 */
  private dshVersionProbe: Promise<string | null> | null = null
  /** 首页认证门判定缓存（按实例对象弱引用，实例更替自然失效）。 */
  private readonly indexGates = new WeakMap<Instance, boolean>()
  /** 进行中的首页探测（WeakSet 去重，避免轮询期间叠加探测）。 */
  private readonly indexProbing = new WeakSet<Instance>()

  constructor(private readonly config: ServerConfig) {
    this.portGuard = createPortGuard(config.portGuard)
  }

  /** 拉起用户的常驻主 DSH（看门狗按需拉起）。 */
  async launch(userId: string, folder: string, patchPath?: string): Promise<Instance> {
    const existing = this.mains.get(userId)
    if (existing !== undefined && (existing.status === 'starting' || existing.status === 'running')) {
      throw new AlreadyRunningError(userId)
    }
    // crashed/stopped 状态的条目是崩溃循环的过期残留，不是运行中的 DSH：
    // 清掉它（以及任何待处理的自动重启），让用户可以重新拉起。
    if (existing !== undefined) this.stop(userId)
    return await this.spawnInstance(userId, 'main', folder, patchPath)
  }

  /** 停止当前主 DSH（干净地）并以相同的文件夹/patch 重新拉起。 */
  async restartMain(userId: string): Promise<Instance | undefined> {
    const current = this.mains.get(userId)
    if (current === undefined) return undefined
    this.killInstance(userId, current)
    return await this.spawnInstance(userId, 'main', current.folder, current.patchPath)
  }

  /** 为用户当前的主 DSH 拉起一个一次性看门狗（修复 / 执行）。 */
  async spawnWatchdog(userId: string): Promise<Instance | undefined> {
    if (!this.config.enablePatch) return undefined // 看门狗需要运行时 patch
    if (this.watchdogs.has(userId)) return this.watchdogs.get(userId)
    const main = this.mains.get(userId)
    if (main === undefined) return undefined
    return await this.spawnInstance(userId, 'watchdog', main.folder)
  }

  /** 用户当前的主 DSH + 看门狗。 */
  status(userId: string): UserStatus {
    return { main: this.mains.get(userId), watchdog: this.watchdogs.get(userId) }
  }

  /** 全部被跟踪实例的快照（管理台全局视图；主实例在前）。 */
  listInstances(): InstanceSummary[] {
    const summarize = (instance: Instance): InstanceSummary => ({
      userId: instance.userId,
      role: instance.role,
      status: instance.status,
      port: instance.port,
      pid: instance.pid,
      startedAt: instance.startedAt,
      restarts: instance.restarts ?? 0,
      lastError: instance.lastError,
    })
    return [...this.mains.values()].map(summarize).concat([...this.watchdogs.values()].map(summarize))
  }

  /** 用户运行中主 DSH 的环回端口（若有）。 */
  portFor(userId: string): number | undefined {
    return this.mains.get(userId)?.port
  }

  /** 当前 dsh CLI 的版本行（`dsh --version` 首行）；探测失败为 null。
   * dsh 二进制支持免重建热更新（bind mount 替换），因此结果按 TTL
   * 过期重探，而不是只在进程启动时探测一次。 */
  async dshVersion(): Promise<string | null> {
    if (this.dshVersionCache !== null && Date.now() - this.dshVersionCache.at < DSH_VERSION_TTL_MS) {
      return this.dshVersionCache.value
    }
    if (this.dshVersionProbe === null) {
      this.dshVersionProbe = probeDshVersion(this.config.dshCommand)
        .then((value) => {
          this.dshVersionCache = { value, at: Date.now() }
          return value
        })
        .finally(() => {
          this.dshVersionProbe = null
        })
    }
    return this.dshVersionProbe
  }

  /** 用户打开以访问运行中子 DSH 的 URL；'' = 暂不可达或尚未就绪。
   * 内网模式：已发布端口 + 转发器令牌（首导航由转发器交接 DSH 自己
   * 的 launchToken，见 forwarder.ts）。回环开发模式：直连子进程端口，
   * 新版 dsh（≥0.1.2-alpha.5）的首页认证门需要它自己的 launchToken ——
   * stdout 捕获就绪前返回 ''（桌面端持续快轮询直到就绪）；老版无门，
   * 探测确认后直接可达。 */
  async dshUrl(userId: string): Promise<string> {
    const main = this.mains.get(userId)
    if (main === undefined || main.port === undefined) return ''
    if (this.config.publicHost !== '') {
      const host = this.config.publicHost
      return main.token === undefined
        ? `http://${host}:${main.port}/`
        : `http://${host}:${main.port}/?dsh_token=${main.token}`
    }
    const host = this.config.host
    const loopback = host === '127.0.0.1' || host === 'localhost' || host === '::1'
    if (!loopback) return ''
    if (main.launchToken !== undefined) return `http://127.0.0.1:${main.port}/?token=${main.launchToken}`
    return (await this.indexGated(main)) ? '' : `http://127.0.0.1:${main.port}/`
  }

  /** 子 DSH 首页是否处于 launchToken 认证门后；判定结果按实例缓存。
   * 探测在后台进行 —— 状态轮询绝不被探测阻塞（connect 在个别环境
   * 可能悬挂），未判定期间按"有门"处理（url 留空，下一次轮询用缓存）。
   * 探测失败（尚未监听）不缓存，等下一轮再判。 */
  private async indexGated(main: Instance): Promise<boolean> {
    const cached = this.indexGates.get(main)
    if (cached !== undefined) return cached
    if (main.port === undefined) return true
    if (!this.indexProbing.has(main)) {
      this.indexProbing.add(main)
      void probeIndex(main.port)
        .then((state) => {
          if (state !== 'down') this.indexGates.set(main, state === 'gated')
        })
        .finally(() => {
          this.indexProbing.delete(main)
        })
    }
    return true
  }

  /** 停止用户的两个进程（取消任何待处理的重启）。 */
  stop(userId: string): void {
    const timer = this.restartTimers.get(userId)
    if (timer !== undefined) {
      clearTimeout(timer)
      this.restartTimers.delete(userId)
    }
    const main = this.mains.get(userId)
    const watchdog = this.watchdogs.get(userId)
    if (main !== undefined) this.killInstance(userId, main)
    if (watchdog !== undefined) this.killInstance(userId, watchdog)
    this.killForwarder(userId)
    this.mains.delete(userId)
    this.watchdogs.delete(userId)
  }

  /** 关停时停止所有被跟踪的进程。 */
  teardown(): void {
    for (const userId of [...this.mains.keys(), ...this.watchdogs.keys()]) this.stop(userId)
  }

  private handoffPath(userId: string): string {
    return join(this.config.dataRoot, 'users', userId, 'handoff.json')
  }

  private baseEnv(userId: string): Record<string, string> {
    const home = userHomeDir(this.config, userId)
    const workspace = workspaceRoot(this.config, userId)
    return {
      ...scrubEnv(process.env),
      // HOME 决定子进程的目录选择器默认值（homedir()）；把它指向
      // 用户的工作区，让用户看到自己的文件夹，而不是 DSH 的内部主目录。
      HOME: workspace,
      // DSH 自身的状态（profile/会话/凭据）留在 `home`。
      DSH_HOME: home,
    }
  }

  private async spawnInstance(
    userId: string,
    role: InstanceRole,
    folder: string,
    patchPath?: string,
    carryRestarts = 0,
  ): Promise<Instance> {
    // 令牌与端口同生命周期：崩溃重启（新端口）自然换新令牌；
    // 手动重启也换新 —— 旧链接立即作废，无残留窗口。
    const instance: Instance = {
      id: randomUUID(),
      userId,
      role,
      folder,
      status: 'starting',
      startedAt: Date.now(),
      restarts: carryRestarts,
      patchPath,
      token: role === 'main' && this.config.publicHost !== '' ? randomBytes(32).toString('base64url') : undefined,
    }
    // 先同步占住槽位再 await：否则两次并发 launch 会在 findFreePort
    // 的 await 处交错通过“已有运行中实例”检查，各自 spawn 一个子进程
    // （其中一个从此脱离管理）。
    const map = role === 'main' ? this.mains : this.watchdogs
    map.set(userId, instance)
    if (role === 'main') {
      try {
        instance.port = await findFreePort(this.config.dshPortMin, this.config.dshPortMax)
      } catch (err) {
        // 端口范围耗尽等后台失败要反映到实例上（crashed 可被再次
        // launch 清理），而不是留下一个永远 starting 的占位条目。
        instance.status = 'crashed'
        instance.lastError = err instanceof Error ? err.message : String(err)
        throw err
      }
    }

    const [command = 'dsh', ...args] = this.config.dshCommand
    const launchArgs = ['--profile', role === 'main' ? MAIN_PROFILE : 'headless']
    if (role === 'main') {
      // dsh CLI 刻意拒绝 --host 0.0.0.0（RCE 暴露防护），因此子进程
      // 始终绑定环回。在内网模式（publicHost）下直接发布子端口；
      // 每个主实例一个进程内 HTTP/WS 转发器，把容器的 eth0 桥接到该
      // 环回监听（见 forwarder.ts）。
      launchArgs.push('--host', '127.0.0.1', '--port', String(instance.port))
      // --patch 需要支持它的 dsh CLI；默认关闭，这样子进程在较老的
      // dsh 版本上也能启动。
      if (this.config.enablePatch && patchPath !== undefined) launchArgs.push('--patch', patchPath)
    } else {
      launchArgs.push(WATCHDOG_TASK)
    }

    const env: Record<string, string> = {
      ...this.baseEnv(userId),
      DSH_ADMIN_ROLE: role,
      DSH_ADMIN_HANDOFF_PATH: this.handoffPath(userId), // 两种角色：main 写入，watchdog 读取
    }
    if (role === 'main') {
      env.DSH_ADMIN_PORT = String(instance.port)
    }

    const child = this.spawnAsUser(userId, command, [...args, ...launchArgs], { cwd: folder, env })
    this.trackChild(userId, instance, child)
    if (role === 'main' && instance.port !== undefined && instance.token !== undefined) {
      this.syncForwarder(userId, instance.port, instance.token, () => instance.launchToken)
    }
    return instance
  }

  /** 内网模式下，把用户已发布的端口（重新）指向子进程的环回监听
   * （HTTP/WS 反向代理；剥除 Origin + 注入 randomUUID 垫片 + 访问令牌
   * 门禁 + DSH web 首页令牌交接 —— 见 forwarder.ts）。崩溃重启会换一个
   * 新端口，因此要替换任何过期残留的转发器。 */
  private syncForwarder(userId: string, port: number, token: string, launchToken: () => string | undefined): void {
    if (this.config.publicHost === '') return
    if (this.lanIp === null) this.lanIp = firstLanIpv4()
    if (this.lanIp === null) {
      process.stderr.write('[dsh-forwarder] 未发现非内部 IPv4 地址；直连链接已禁用\n')
      return
    }
    this.killForwarder(userId)
    void startForwarder(this.lanIp, port, token, launchToken)
      .then((server) => this.forwarders.set(userId, server))
      .catch((err: unknown) => {
        // 转发器失败绝不能拖垮子进程；直连链接随之失效。
        process.stderr.write(`[dsh-forwarder ${port}] ${String(err)}\n`)
      })
  }

  private killForwarder(userId: string): void {
    const fwd = this.forwarders.get(userId)
    if (fwd === undefined) return
    this.forwarders.delete(userId)
    fwd.close()
  }

  /** 拉起子进程，可选地经由账户级 setuid 包装器。 */
  private spawnAsUser(
    userId: string,
    command: string,
    args: string[],
    options: { cwd: string; env: Record<string, string> },
  ): ChildProcess {
    const stdio: StdioOptions = ['ignore', 'pipe', 'pipe']
    if (this.config.isolationMode !== 'account') {
      return spawn(command, args, { ...options, stdio })
    }
    const uid = uidForUser(userId, this.config.baseUid)
    const prefix = this.config.spawnAsUserCommand.map((part) =>
      part.replaceAll('{UID}', String(uid)).replaceAll('{GID}', String(uid)),
    )
    const [asCommand = 'setpriv', ...asArgs] = prefix
    return spawn(asCommand, [...asArgs, command, ...args], { ...options, stdio })
  }

  private trackChild(userId: string, instance: Instance, child: ChildProcess): void {
    this.children.set(instance.id, child)
    child.on('spawn', () => {
      instance.pid = child.pid ?? undefined
      if (instance.role === 'main' && instance.port !== undefined) {
        if (this.portGuard !== undefined) {
          try {
            this.portGuard.install(instance.port)
          } catch (error) {
            // 故障即关闭（fail closed）：没有端口守卫，同租户本地用户就能
            // 直接连到这个 DSH 的环回 RPC。杀掉刚拉起的子进程并把实例
            // 标记为 crashed，而不是在无守卫状态下继续服务。
            instance.status = 'crashed'
            instance.lastError = error instanceof Error ? error.message : String(error)
            child.kill('SIGKILL')
            return
          }
        }
        // 进程已 spawn ≠ 服务已就绪：保持 starting，直到环回监听真正
        // 接受连接才转 running —— UI 的"运行中"反映服务可用性。
        void this.markRunningWhenListening(instance)
      } else {
        instance.status = 'running'
      }
    })
    // 子进程 stdout 透传到编排器输出，同时扫描 `dsh web: …?token=…`
    // 行捕获 web 首页认证的 launchToken（行可能跨 chunk 到达，需按
    // 累积缓冲匹配；找到即停，缓冲封顶防止老版本 dsh 不打印时无界增长）。
    let scan = ''
    child.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString()
      process.stdout.write(text)
      if (instance.launchToken !== undefined) return
      scan = (scan + text).slice(-8192)
      const match = scan.match(/dsh web: \S*\/\?token=([A-Za-z0-9_-]{20,})/)
      if (match !== null) {
        instance.launchToken = match[1]
        scan = ''
      }
    })
    let stderrTail = ''
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-2048)
      // 同时把子进程的 stderr 透传到编排器自己的 stderr，这样启动
      // 崩溃在 journald 里可见，而不只存在于 lastError 中。
      process.stderr.write(`[dsh-child ${instance.role}] ${chunk.toString()}`)
    })
    child.on('error', (err) => {
      instance.status = 'crashed'
      instance.lastError = err.message
      this.children.delete(instance.id)
      // spawn 失败（如 ENOENT）不会触发 exit；看门狗的一次性槽位
      // 不在这里清掉的话，后续 spawnWatchdog 会一直拿到死条目。
      if (instance.role === 'watchdog') this.watchdogs.delete(userId)
    })
    child.on('exit', (code) => {
      instance.exitCode = code ?? undefined
      this.children.delete(instance.id)
      // 主实例的进程一消失就立即释放环回端口守卫
      // （显式停止、重启和崩溃都会经过这个处理器）。
      if (instance.role === 'main' && instance.port !== undefined) {
        this.portGuard?.remove(instance.port)
      }
      const map = instance.role === 'main' ? this.mains : this.watchdogs
      // 仅当该实例仍是当前实例时才行动（避免过期残留的
      // 退出处理器波及刚重启的新实例）。
      if (map.get(userId)?.id !== instance.id) return
      if (instance.status === 'stopped') {
        map.delete(userId)
        return
      }
      // 干净结束的一次性看门狗不会被重启。
      if (instance.role === 'watchdog' && code === 0) {
        instance.status = 'stopped'
        map.delete(userId)
        return
      }
      instance.status = 'crashed'
      instance.lastError = stderrTail.slice(-500) || undefined
      if (instance.role === 'main') {
        this.spawnWatchdog(userId).catch((err: unknown) => {
          // 看门狗是尽力而为的修复；它的失败绝不能让编排器崩溃 ——
          // 下面的主实例重启才是真正的恢复手段。
          process.stderr.write(`[watchdog ${userId}] ${String(err)}\n`)
        })
        this.scheduleRestart(userId, instance)
      } else {
        map.delete(userId)
      }
    })
  }

  private scheduleRestart(userId: string, instance: Instance): void {
    const restarts = (instance.restarts ?? 0) + 1
    const max = this.config.maxAutoRestarts
    if (max > 0 && restarts > max) {
      // 熔断：自动重启上限已到仍持续崩溃，停止重拉等用户处理。
      // 条目留在 map 里保持 crashed（可被 launch 清理重启）。
      instance.restarts = restarts
      instance.lastError = `已自动重启 ${restarts - 1} 次仍持续崩溃，停止自动重启（熔断）；请检查子进程日志后手动启动`
      return
    }
    instance.restarts = restarts
    // 指数退避（封顶 30s）：持续失败时 1s 固定延迟会让崩溃循环以
    // 全速空转，退避把无效重启的资源消耗压下来。
    const delay = Math.min(this.config.restartBackoffMs * 2 ** (restarts - 1), 30_000)
    const timer = setTimeout(() => {
      this.restartTimers.delete(userId)
      this.spawnInstance(userId, instance.role, instance.folder, instance.patchPath, restarts).catch(
        (err: unknown) => {
          // spawnInstance 已把失败写进实例（crashed + lastError）；
          // 这里只需让重启失败在日志里可见。
          process.stderr.write(`[restart ${userId}] ${String(err)}\n`)
        },
      )
    }, delay)
    timer.unref()
    this.restartTimers.set(userId, timer)
  }

  /** 轮询实例的环回端口直到接受连接，才把 status 置为 running。
   * 实例提前退出/被停止（status 离开 starting）或超过探测时长时静默结束。 */
  private async markRunningWhenListening(instance: Instance): Promise<void> {
    const deadline = Date.now() + READY_PROBE_TIMEOUT_MS
    while (instance.status === 'starting' && Date.now() < deadline) {
      if (await probePort(instance.port!)) {
        // 仅当仍是同一个 starting 实例时转 running（探测期间可能已崩溃/停止）。
        if (instance.status === 'starting') {
          instance.status = 'running'
          // 服务真正可用 = 本轮崩溃循环结束，熔断计数归零。
          instance.restarts = 0
        }
        return
      }
      await new Promise((resolve) => setTimeout(resolve, READY_PROBE_INTERVAL_MS))
    }
  }

  private killInstance(userId: string, instance: Instance): void {
    instance.status = 'stopped'
    if (instance.role === 'main') this.killForwarder(userId)
    const child = this.children.get(instance.id)
    if (child === undefined) return
    child.kill('SIGTERM')
    const killer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }, 5000)
    killer.unref()
  }
}
