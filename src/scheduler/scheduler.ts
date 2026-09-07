/**
 * 定时 agent 任务调度器：轮询 `scheduled_tasks` 里到期的任务，用
 * Supervisor.runHeadless 拉起一次性 headless DSH 执行，记录运行历史。
 *
 * 设计约束：
 * - 单用户并发 1：同一用户的上一个任务没跑完时，本轮跳过（headless
 *   会话共享同一 DSH home，并行任务会争抢会话日志）。webhook 触发的
 *   一次性任务经 {@link tryAcquireUser}/{@link releaseUser} 共用同一
 *   通道，两条触发路径互斥。
 * - 到期即重排：fire 时先把 next_run_at 推到下一轮再执行，服务器在
 *   执行中途崩溃也不会重复触发；错过的运行（服务器关停期间）在启动
 *   后的第一个 tick 补跑一次。
 * - fire 不等待执行：execute 是 fire-and-forget，tick 只负责触发，
 *   单个跑几十分钟的任务不会阻塞同一轮的后续任务。
 * - 进程计数/熔断与主实例编排无关（那是常驻服务；这里是按需任务）。
 * @module dsh-admin/scheduler/scheduler
 */

import { randomUUID } from 'node:crypto'
import type { Database } from '../db/connection.js'
import type { ServerConfig } from '../config.js'
import {
  failStaleRunningRuns,
  finishTaskRun,
  insertTaskRun,
  listDueTasks,
  recordTaskFired,
  recordTaskResult,
  type ScheduledTaskRow,
} from '../db/repo.js'
import type { Supervisor } from '../supervisor/orchestrator.js'
import { workspaceRoot } from '../fs/workspace.js'

/** 调度轮询间隔：细于分钟级的任务粒度下，30s 足够且查询开销可忽略。 */
const TICK_MS = 30_000
/** 单轮最多触发的任务数（防止唤醒风暴）。 */
const MAX_FIRE_PER_TICK = 5

/** headless 一次性任务的统一状态映射（定时任务与 webhook 共用）。 */
export function headlessRunStatus(result: { timedOut: boolean; code: number | null }): 'ok' | 'fail' | 'timeout' {
  return result.timedOut ? 'timeout' : result.code === 0 ? 'ok' : 'fail'
}

/** 计算任务的下次运行时间（本地时间语义）。
 * @param from - 基准时刻（fire 时刻或编辑时刻），返回值严格大于它。 */
export function computeNextRunAt(task: Pick<ScheduledTaskRow, 'scheduleKind' | 'intervalMinutes' | 'dailyTime'>, from: number): number {
  if (task.scheduleKind === 'interval') {
    const minutes = task.intervalMinutes ?? 60
    return from + minutes * 60_000
  }
  const [hh, mm] = (task.dailyTime ?? '09:00').split(':').map(Number)
  const next = new Date(from)
  next.setHours(hh ?? 0, mm ?? 0, 0, 0)
  if (next.getTime() <= from) next.setDate(next.getDate() + 1)
  return next.getTime()
}

export class Scheduler {
  /** 运行中的任务 id（含手动触发）；用于并发守卫与状态展示。 */
  private readonly running = new Map<string, string>()
  /** 经 webhook 触发、不挂在任务 id 下的 headless 占用（按用户）。 */
  private readonly adhocUsers = new Set<string>()
  /** tick 重入守卫（setInterval 重叠触发时后到者直接让路）。 */
  private ticking = false
  private timer: NodeJS.Timeout | undefined

  constructor(
    private readonly config: ServerConfig,
    private readonly db: Database,
    private readonly supervisor: Supervisor,
  ) {}

  start(): void {
    // 上次进程生命周期的孤儿「running」运行收尾。
    failStaleRunningRuns(this.db, Date.now())
    this.timer = setInterval(() => {
      void this.tick()
    }, TICK_MS)
    this.timer.unref()
    void this.tick()
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer)
  }

  /** 任务当前是否有运行中的实例（路由 409 判定与列表展示）。 */
  isRunning(taskId: string): boolean {
    return this.running.has(taskId)
  }

  /** 该用户是否还有 headless 任务在跑（定时、手动或 webhook）。 */
  hasRunningForUser(userId: string): boolean {
    for (const uid of this.running.values()) {
      if (uid === userId) return true
    }
    return this.adhocUsers.has(userId)
  }

  /** webhook 触发前占用该用户的 headless 通道；false = 已有任务在跑，
   * 调用方应拒绝（避免并行 headless 争抢同一 DSH home）。 */
  tryAcquireUser(userId: string): boolean {
    if (this.hasRunningForUser(userId)) return false
    this.adhocUsers.add(userId)
    return true
  }

  /** 释放 {@link tryAcquireUser} 占用的通道。 */
  releaseUser(userId: string): void {
    this.adhocUsers.delete(userId)
  }

  /** 手动立即运行（不改变排程；触发器记为 manual）。 */
  async runNow(task: ScheduledTaskRow): Promise<void> {
    await this.execute(task, 'manual', false)
  }

  private async tick(): Promise<void> {
    if (this.ticking) return
    this.ticking = true
    try {
      const due = listDueTasks(this.db, Date.now(), MAX_FIRE_PER_TICK)
      let fired = 0
      for (const task of due) {
        if (fired >= MAX_FIRE_PER_TICK) break
        if (this.running.has(task.id)) continue
        if (this.hasRunningForUser(task.userId)) continue
        // fire 即返回：execute 自己登记 running/重排/回写，失败的
        // 任务也不会拖住同一轮的其他到期任务。
        void this.execute(task, 'scheduled', true)
        fired++
      }
    } finally {
      this.ticking = false
    }
  }

  /** 执行任务本体：登记 run 行 → （排程触发时）先重排 → 跑 headless →
   * 回写结果。失败不抛出（调度器永不因任务崩溃）。 */
  private async execute(task: ScheduledTaskRow, triggerKind: 'scheduled' | 'manual', reschedule: boolean): Promise<void> {
    this.running.set(task.id, task.userId)
    const runId = crypto.randomUUID()
    const startedAt = Date.now()
    try {
      insertTaskRun(this.db, { id: runId, taskId: task.id, triggerKind, startedAt })
      if (reschedule) {
        recordTaskFired(this.db, task.id, startedAt, computeNextRunAt(task, startedAt))
      }
      const result = await this.supervisor.runHeadless(task.userId, task.prompt, {
        timeoutMs: this.config.scheduledTaskTimeoutMs,
        cwd: workspaceRoot(this.config, task.userId),
      })
      const status = headlessRunStatus(result)
      const detail = result.timedOut
        ? `超过 ${Math.round(this.config.scheduledTaskTimeoutMs / 60_000)} 分钟被终止；输出尾部：${result.outputTail}`
        : result.code === 0
          ? result.outputTail || undefined
          : `退出码 ${result.code ?? '未知（spawn 失败）'}；输出尾部：${result.outputTail}`
      finishTaskRun(this.db, runId, { finishedAt: Date.now(), status, detail })
      recordTaskResult(this.db, task.id, status, startedAt)
    } catch (err) {
      try {
        finishTaskRun(this.db, runId, {
          finishedAt: Date.now(),
          status: 'fail',
          detail: `调度器内部错误：${err instanceof Error ? err.message : String(err)}`,
        })
        recordTaskResult(this.db, task.id, 'fail', startedAt)
      } catch {
        // 连回写都失败时只能放弃（数据库不可用）。
      }
    } finally {
      this.running.delete(task.id)
    }
  }
}
