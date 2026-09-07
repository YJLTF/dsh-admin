/**
 * 定时 agent 任务路由（用户侧）：每用户用自然语言 prompt 定义排程任务
 * （间隔分钟 / 每日固定时刻），由 Scheduler 用一次性 headless DSH 在该
 * 用户的工作区里执行。任务归属严格按 user_id 隔离；运行历史含输出尾部。
 * @module dsh-admin/web/routes/tasks
 */

import type { FastifyPluginAsync } from 'fastify'
import { randomUUID } from 'node:crypto'
import { requireAuth } from '../middleware/authn.js'
import { parseLimit } from '../params.js'
import {
  audit,
  countUserTasks,
  deleteScheduledTask,
  findScheduledTask,
  insertScheduledTask,
  listTaskRuns,
  listUserTasks,
  updateScheduledTask,
} from '../../db/repo.js'
import { computeNextRunAt } from '../../scheduler/scheduler.js'

/** 每用户任务数上限（防滥用；够覆盖合理的自动化场景）。 */
const MAX_TASKS_PER_USER = 20

const DAILY_TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/

function parseSchedule(body: { schedule: { kind: string; intervalMinutes?: unknown; dailyTime?: unknown } }):
  | { ok: true; kind: 'interval' | 'daily'; intervalMinutes: number | null; dailyTime: string | null }
  | { ok: false; message: string } {
  const kind = body.schedule?.kind
  if (kind === 'interval') {
    const minutes = body.schedule.intervalMinutes
    const n = typeof minutes === 'number' ? minutes : Number(minutes)
    if (!Number.isInteger(n) || n < 1 || n > 60 * 24 * 7) {
      return { ok: false, message: '间隔分钟数应为 1–10080 的整数' }
    }
    return { ok: true, kind, intervalMinutes: n, dailyTime: null }
  }
  if (kind === 'daily') {
    const time = body.schedule.dailyTime
    if (typeof time !== 'string' || !DAILY_TIME_RE.test(time)) {
      return { ok: false, message: '每日时间应为 HH:MM（本地时间）' }
    }
    return { ok: true, kind, intervalMinutes: null, dailyTime: time }
  }
  return { ok: false, message: 'schedule.kind 应为 interval 或 daily' }
}

const scheduleSchema = {
  type: 'object',
  required: ['kind'],
  additionalProperties: false,
  properties: {
    kind: { type: 'string', enum: ['interval', 'daily'] },
    intervalMinutes: { type: 'number' },
    dailyTime: { type: 'string' },
  },
} as const

const createSchema = {
  body: {
    type: 'object',
    required: ['name', 'prompt', 'schedule'],
    additionalProperties: false,
    properties: {
      name: { type: 'string', minLength: 1, maxLength: 80 },
      prompt: { type: 'string', minLength: 1, maxLength: 4000 },
      schedule: scheduleSchema,
    },
  },
} as const

const updateSchema = {
  body: {
    type: 'object',
    additionalProperties: false,
    properties: {
      name: { type: 'string', minLength: 1, maxLength: 80 },
      prompt: { type: 'string', minLength: 1, maxLength: 4000 },
      enabled: { type: 'boolean' },
      schedule: scheduleSchema,
    },
  },
} as const

export const taskRoutes: FastifyPluginAsync = async (app) => {
  /** 校验路径参数指向当前用户自己的任务；否则 404（不泄露他人任务存在）。 */
  async function ownedTask(request: import('fastify').FastifyRequest, reply: import('fastify').FastifyReply) {
    const { id } = request.params as { id: string }
    const task = findScheduledTask(app.db, id)
    if (task === undefined || task.userId !== request.user!.id) {
      reply.code(404).send({ error: 'not_found' })
      return undefined
    }
    return task
  }

  app.get('/api/me/tasks', { preHandler: requireAuth }, async (request) => {
    const tasks = listUserTasks(app.db, request.user!.id)
    return {
      tasks: tasks.map((task) => ({
        id: task.id,
        name: task.name,
        prompt: task.prompt,
        scheduleKind: task.scheduleKind,
        intervalMinutes: task.intervalMinutes,
        dailyTime: task.dailyTime,
        enabled: task.enabled,
        createdAt: task.createdAt,
        lastRunAt: task.lastRunAt,
        lastStatus: task.lastStatus,
        nextRunAt: task.nextRunAt,
        running: app.scheduler.isRunning(task.id),
      })),
    }
  })

  app.post('/api/me/tasks', { preHandler: requireAuth, schema: createSchema }, async (request, reply) => {
    const body = request.body as { name: string; prompt: string; schedule: { kind: string; intervalMinutes?: unknown; dailyTime?: unknown } }
    const schedule = parseSchedule(body)
    if (!schedule.ok) return reply.code(422).send({ error: 'invalid_schedule', message: schedule.message })
    if (countUserTasks(app.db, request.user!.id) >= MAX_TASKS_PER_USER) {
      return reply.code(409).send({ error: 'too_many_tasks', message: `每人最多 ${MAX_TASKS_PER_USER} 个定时任务` })
    }
    const now = Date.now()
    const task = {
      id: randomUUID(),
      userId: request.user!.id,
      name: body.name,
      prompt: body.prompt,
      scheduleKind: schedule.kind,
      intervalMinutes: schedule.intervalMinutes,
      dailyTime: schedule.dailyTime,
      enabled: true,
      createdAt: now,
      nextRunAt: computeNextRunAt(
        { scheduleKind: schedule.kind, intervalMinutes: schedule.intervalMinutes, dailyTime: schedule.dailyTime },
        now,
      ),
    }
    insertScheduledTask(app.db, task)
    audit(app.db, request.user!.id, 'task_create', JSON.stringify({ name: task.name, scheduleKind: task.scheduleKind }))
    return { ok: true, id: task.id }
  })

  app.put('/api/me/tasks/:id', { preHandler: requireAuth, schema: updateSchema }, async (request, reply) => {
    const task = await ownedTask(request, reply)
    if (task === undefined) return
    if (app.scheduler.isRunning(task.id)) {
      return reply.code(409).send({ error: 'task_running', message: '任务正在运行，稍后再改' })
    }
    const body = request.body as { name?: string; prompt?: string; enabled?: boolean; schedule?: { kind: string; intervalMinutes?: unknown; dailyTime?: unknown } }
    const fields: {
      name?: string
      prompt?: string
      enabled?: boolean
      nextRunAt?: number
      schedule?: { kind: 'interval' | 'daily'; intervalMinutes: number | null; dailyTime: string | null }
    } = {}
    if (body.name !== undefined) fields.name = body.name
    if (body.prompt !== undefined) fields.prompt = body.prompt
    if (body.enabled !== undefined) fields.enabled = body.enabled
    if (body.schedule !== undefined) {
      const schedule = parseSchedule({ schedule: body.schedule })
      if (!schedule.ok) return reply.code(422).send({ error: 'invalid_schedule', message: schedule.message })
      // 排程是两列结构（kind + 参数），同一条 UPDATE 覆盖并重排。
      fields.schedule = { kind: schedule.kind, intervalMinutes: schedule.intervalMinutes, dailyTime: schedule.dailyTime }
      fields.nextRunAt = computeNextRunAt(
        { scheduleKind: schedule.kind, intervalMinutes: schedule.intervalMinutes, dailyTime: schedule.dailyTime },
        Date.now(),
      )
    } else if (body.enabled === true || body.prompt !== undefined || body.name !== undefined) {
      // 启用/改 prompt 时也重排，让「启用」立即有明确的下次运行时刻。
      fields.nextRunAt = computeNextRunAt(task, Date.now())
    }
    updateScheduledTask(app.db, task.id, fields)
    audit(app.db, request.user!.id, 'task_update', JSON.stringify({ id: task.id, fields: Object.keys(fields) }))
    return { ok: true }
  })

  app.delete('/api/me/tasks/:id', { preHandler: requireAuth }, async (request, reply) => {
    const task = await ownedTask(request, reply)
    if (task === undefined) return
    if (app.scheduler.isRunning(task.id)) {
      return reply.code(409).send({ error: 'task_running', message: '任务正在运行，稍后再删（或先等它结束）' })
    }
    deleteScheduledTask(app.db, task.id)
    audit(app.db, request.user!.id, 'task_delete', JSON.stringify({ id: task.id, name: task.name }))
    return { ok: true }
  })

  /** 手动立即运行：异步执行（headless 任务可能跑几分钟），返回 run id；
   * 排程不受影响。每次运行都是一个最长达超时上限的 headless 进程，
   * 路由级限流防误触风暴。 */
  app.post(
    '/api/me/tasks/:id/run',
    { preHandler: requireAuth, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const task = await ownedTask(request, reply)
      if (task === undefined) return
      if (app.scheduler.isRunning(task.id)) {
        return reply.code(409).send({ error: 'task_running', message: '任务已在运行中' })
      }
      audit(app.db, request.user!.id, 'task_run_manual', JSON.stringify({ id: task.id, name: task.name }))
      void app.scheduler.runNow(task)
      return { ok: true }
    },
  )

  app.get('/api/me/tasks/:id/runs', { preHandler: requireAuth }, async (request, reply) => {
    const task = await ownedTask(request, reply)
    if (task === undefined) return
    return { runs: listTaskRuns(app.db, task.id, parseLimit((request.query as { limit?: string }).limit, 20, 100)) }
  })
}
