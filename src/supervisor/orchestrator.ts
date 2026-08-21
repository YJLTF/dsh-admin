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
import { randomUUID } from 'node:crypto'
import { networkInterfaces } from 'node:os'
import { join } from 'node:path'
import type { Server as HttpServer } from 'node:http'
import type { ServerConfig } from '../config.js'
import { uidForUser } from '../isolation.js'
import { MAIN_PROFILE } from '../fs/plugins.js'
import { userHomeDir, workspaceRoot } from '../fs/workspace.js'
import { startForwarder } from './forwarder.js'
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
  exitCode?: number
  lastError?: string
  patchPath?: string
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

  /** 用户运行中主 DSH 的环回端口（若有）。 */
  portFor(userId: string): number | undefined {
    return this.mains.get(userId)?.port
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

  private async spawnInstance(userId: string, role: InstanceRole, folder: string, patchPath?: string): Promise<Instance> {
    const port = role === 'main' ? await findFreePort(this.config.dshPortMin, this.config.dshPortMax) : undefined
    const instance: Instance = {
      id: randomUUID(),
      userId,
      role,
      folder,
      port,
      status: 'starting',
      patchPath,
    }
    const map = role === 'main' ? this.mains : this.watchdogs
    map.set(userId, instance)

    const [command = 'dsh', ...args] = this.config.dshCommand
    const launchArgs = ['--profile', role === 'main' ? MAIN_PROFILE : 'headless']
    if (role === 'main') {
      // dsh CLI 刻意拒绝 --host 0.0.0.0（RCE 暴露防护），因此子进程
      // 始终绑定环回。在内网模式（publicHost）下直接发布子端口；
      // 每个主实例一个 socat 转发器，把容器的 eth0 桥接到该环回监听
      // （见 spawnForwarder）。
      launchArgs.push('--host', '127.0.0.1', '--port', String(port))
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
      env.DSH_ADMIN_PORT = String(port)
    }

    const child = this.spawnAsUser(userId, command, [...args, ...launchArgs], { cwd: folder, env })
    this.trackChild(userId, instance, child)
    if (role === 'main' && port !== undefined) this.syncForwarder(userId, port)
    return instance
  }

  /** 内网模式下，把用户已发布的端口（重新）指向子进程的环回监听
   * （HTTP/WS 反向代理；剥除 Origin + 注入 randomUUID 垫片 ——
   * 见 forwarder.ts）。崩溃重启会换一个新端口，因此要替换任何
   * 过期残留的转发器。 */
  private syncForwarder(userId: string, port: number): void {
    if (this.config.publicHost === '') return
    if (this.lanIp === null) this.lanIp = firstLanIpv4()
    if (this.lanIp === null) {
      process.stderr.write('[dsh-forwarder] 未发现非内部 IPv4 地址；直连链接已禁用\n')
      return
    }
    this.killForwarder(userId)
    void startForwarder(this.lanIp, port)
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
      instance.status = 'running'
      instance.pid = child.pid ?? undefined
      if (instance.role === 'main' && instance.port !== undefined && this.portGuard !== undefined) {
        try {
          this.portGuard.install(instance.port)
        } catch (error) {
          // 故障即关闭（fail closed）：没有端口守卫，同租户本地用户就能
          // 直接连到这个 DSH 的环回 RPC。杀掉刚拉起的子进程并把实例
          // 标记为 crashed，而不是在无守卫状态下继续服务。
          instance.status = 'crashed'
          instance.lastError = error instanceof Error ? error.message : String(error)
          child.kill('SIGKILL')
        }
      }
    })
    child.stdout?.pipe(process.stdout)
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

  /** 把后台拉起失败（例如端口范围耗尽）反映到实例上，
   * 而不是以未处理的 rejection 让编排器崩溃。 */
  private markSpawnFailed(userId: string, role: InstanceRole, err: unknown): void {
    const map = role === 'main' ? this.mains : this.watchdogs
    const instance = map.get(userId)
    if (instance === undefined) return
    instance.status = 'crashed'
    instance.lastError = err instanceof Error ? err.message : String(err)
  }

  private scheduleRestart(userId: string, instance: Instance): void {
    const timer = setTimeout(() => {
      this.restartTimers.delete(userId)
      this.spawnInstance(userId, instance.role, instance.folder, instance.patchPath)
        .catch((err: unknown) => this.markSpawnFailed(userId, instance.role, err))
    }, this.config.restartBackoffMs)
    timer.unref()
    this.restartTimers.set(userId, timer)
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
