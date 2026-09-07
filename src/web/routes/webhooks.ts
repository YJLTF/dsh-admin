/**
 * 入站 webhook 路由：把内网事件（CI 完成、审批通过、表单提交…）转换成
 * 一次性 headless DSH 任务。
 *
 * - 触发端点 `POST /hooks/:token` 是**公开**的（内网自动化系统没有
 *   平台会话）：token 为 128-bit 随机值、库里只存 SHA-256，命中并启用
 *   才执行；失败一律 404（不区分「不存在/已禁用/ token 错」，不泄露
 *   可枚举信息）。触发即异步执行，立即返回（CI 不等 agent 跑完）；
 *   执行经 Scheduler 的单用户并发守卫，与定时任务互斥，通道被占时
 *   返回 429 让调用方退避重试。
 * - 管理端点在 /api/me/webhooks：创建（唯一一次返回完整 token 与 URL）、
 *   列表（只显示哈希前缀）、启停、删除、触发日志。
 * @module dsh-admin/web/routes/webhooks
 */

import type { FastifyPluginAsync } from 'fastify'
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { requireAuth } from '../middleware/authn.js'
import { hashSessionToken } from '../auth.js'
import { parseLimit } from '../params.js'
import { headlessRunStatus } from '../../scheduler/scheduler.js'
import {
  audit,
  countUserWebhooks,
  deleteWebhook,
  findWebhook,
  findWebhookByTokenHash,
  insertWebhook,
  insertWebhookFireLog,
  listUserWebhooks,
  listWebhookFireLog,
  recordWebhookFired,
  setWebhookEnabled,
} from '../../db/repo.js'

const MAX_WEBHOOKS_PER_USER = 10

const createSchema = {
  body: {
    type: 'object',
    required: ['name', 'prompt'],
    additionalProperties: false,
    properties: {
      name: { type: 'string', minLength: 1, maxLength: 80 },
      prompt: { type: 'string', minLength: 1, maxLength: 4000 },
    },
  },
} as const

const enabledSchema = {
  body: {
    type: 'object',
    required: ['enabled'],
    additionalProperties: false,
    properties: { enabled: { type: 'boolean' } },
  },
} as const

function constantTimeHexEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}

export const webhookRoutes: FastifyPluginAsync = async (app) => {
  // ---------- 公开触发端点（不走会话认证；限流必须生效）----------

  app.post('/hooks/:token', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request, reply) => {
    const { token } = request.params as { token: string }
    if (!/^[A-Za-z0-9_-]{20,128}$/.test(token)) return reply.code(404).send({ error: 'not_found' })
    const tokenHash = hashSessionToken(token)
    const hook = findWebhookByTokenHash(app.db, tokenHash)
    if (hook === undefined || !constantTimeHexEqual(hook.tokenHash, tokenHash) || !hook.enabled) {
      return reply.code(404).send({ error: 'not_found' })
    }
    // 与定时任务共用「单用户并发 1」的 headless 通道；被占时让调用
    // 方退避重试，而不是并行拉起第二个 headless 争抢同一 DSH home。
    if (!app.scheduler.tryAcquireUser(hook.userId)) {
      return reply.code(429).send({ error: 'user_busy', message: '该用户的 agent 任务正在执行，请稍后重试' })
    }
    // 触发体若为 JSON，取 message 字段拼进 prompt（如 CI 消息）；其余忽略。
    let context = ''
    const body = request.body as { message?: unknown } | undefined
    if (typeof body?.message === 'string' && body.message !== '') {
      context = `\n\n[事件消息] ${body.message.slice(0, 2000)}`
    }
    const firedAt = Date.now()
    recordWebhookFired(app.db, hook.id, firedAt)
    void app.supervisor
      .runHeadless(hook.userId, hook.prompt + context, {
        timeoutMs: app.config.scheduledTaskTimeoutMs,
      })
      .then((result) => {
        const status = headlessRunStatus(result)
        insertWebhookFireLog(app.db, {
          webhookId: hook.id,
          firedAt,
          status,
          detail: result.timedOut ? '超过时限被终止' : result.code === 0 ? undefined : `退出码 ${result.code ?? '未知'}`,
        })
      })
      .catch((err: unknown) => {
        insertWebhookFireLog(app.db, {
          webhookId: hook.id,
          firedAt,
          status: 'fail',
          detail: err instanceof Error ? err.message : String(err),
        })
      })
      .finally(() => app.scheduler.releaseUser(hook.userId))
    audit(app.db, hook.userId, 'webhook_fire', JSON.stringify({ name: hook.name }))
    return reply.code(202).send({ ok: true, accepted: true })
  })

  // ---------- 用户管理端点 ----------

  app.get('/api/me/webhooks', { preHandler: requireAuth }, async (request) => ({
    webhooks: listUserWebhooks(app.db, request.user!.id).map((hook) => ({
      id: hook.id,
      name: hook.name,
      prompt: hook.prompt,
      enabled: hook.enabled,
      createdAt: hook.createdAt,
      lastFiredAt: hook.lastFiredAt,
      tokenPreview: hook.tokenHash.slice(0, 12) + '…',
      running: app.scheduler.hasRunningForUser(hook.userId),
    })),
  }))

  app.post('/api/me/webhooks', { preHandler: requireAuth, schema: createSchema }, async (request, reply) => {
    const body = request.body as { name: string; prompt: string }
    if (countUserWebhooks(app.db, request.user!.id) >= MAX_WEBHOOKS_PER_USER) {
      return reply.code(409).send({ error: 'too_many_webhooks', message: `每人最多 ${MAX_WEBHOOKS_PER_USER} 个 webhook` })
    }
    const token = randomBytes(24).toString('base64url')
    const hook = {
      id: randomUUID(),
      userId: request.user!.id,
      name: body.name,
      prompt: body.prompt,
      tokenHash: hashSessionToken(token),
      enabled: true,
      createdAt: Date.now(),
    }
    insertWebhook(app.db, hook)
    audit(app.db, request.user!.id, 'webhook_create', JSON.stringify({ name: hook.name }))
    // token 只在此响应出现一次。
    return { ok: true, id: hook.id, token, url: `/hooks/${token}` }
  })

  const idParam = { params: { type: 'object', required: ['id'], properties: { id: { type: 'string', maxLength: 64 } } } } as const

  app.delete('/api/me/webhooks/:id', { preHandler: requireAuth, schema: idParam }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const hook = findWebhook(app.db, id)
    if (hook === undefined || hook.userId !== request.user!.id) return reply.code(404).send({ error: 'not_found' })
    deleteWebhook(app.db, id)
    audit(app.db, request.user!.id, 'webhook_delete', JSON.stringify({ name: hook.name }))
    return { ok: true }
  })

  app.post('/api/me/webhooks/:id/enabled', { preHandler: requireAuth, schema: { ...idParam, ...enabledSchema } }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const { enabled } = request.body as { enabled: boolean }
    const hook = findWebhook(app.db, id)
    if (hook === undefined || hook.userId !== request.user!.id) return reply.code(404).send({ error: 'not_found' })
    setWebhookEnabled(app.db, id, enabled)
    audit(app.db, request.user!.id, 'webhook_toggle', JSON.stringify({ name: hook.name, enabled }))
    return { ok: true }
  })

  app.get('/api/me/webhooks/:id/fires', { preHandler: requireAuth, schema: idParam }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const hook = findWebhook(app.db, id)
    if (hook === undefined || hook.userId !== request.user!.id) return reply.code(404).send({ error: 'not_found' })
    return { fires: listWebhookFireLog(app.db, id, parseLimit((request.query as { limit?: string }).limit, 20, 100)) }
  })
}
