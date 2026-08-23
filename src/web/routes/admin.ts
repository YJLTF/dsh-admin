/**
 * 管理员路由：用户生命周期（批准/停用/重置密码/删除）、系统设置
 * （注册开关/邀请码）与审计日志查看。全部由 `requireAdmin` 守卫。
 * 运维类路由（实例/存储/健康检查）见 ops.ts。
 * @module dsh-admin/web/routes/admin
 */

import type { FastifyPluginAsync } from 'fastify'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { requireAdmin } from '../middleware/authn.js'
import {
  audit,
  deleteUser,
  deleteUserSessions,
  findUserById,
  getSetting,
  listAudit,
  listPublicUsers,
  setSetting,
  setUserRole,
  updateUserPassword,
} from '../../db/repo.js'
import { hashPassword } from '../auth.js'
import { SETTING_ALLOW_REGISTER, SETTING_INVITE_CODE, inviteRequired, registrationOpen } from './auth.js'

const passwordBodySchema = {
  body: {
    type: 'object',
    required: ['newPassword'],
    additionalProperties: false,
    properties: {
      newPassword: { type: 'string', minLength: 8, maxLength: 128 },
    },
  },
} as const

export const adminRoutes: FastifyPluginAsync = async (app) => {
  app.get('/api/admin/users', { preHandler: requireAdmin }, async () => ({
    users: listPublicUsers(app.db),
  }))

  app.post('/api/admin/users/:id/approve', { preHandler: requireAdmin }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const user = findUserById(app.db, id)
    if (user === undefined) return reply.code(404).send({ error: 'not_found' })
    if (user.role !== 'pending') return reply.code(409).send({ error: 'not_pending' })
    setUserRole(app.db, id, 'active', request.user?.id)
    audit(app.db, request.user?.id ?? null, 'approve', JSON.stringify({ userId: id }))
    return { ok: true }
  })

  app.post('/api/admin/users/:id/disable', { preHandler: requireAdmin }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const user = findUserById(app.db, id)
    if (user === undefined) return reply.code(404).send({ error: 'not_found' })
    if (user.role === 'admin') return reply.code(409).send({ error: 'cannot_disable_admin' })
    setUserRole(app.db, id, 'disabled', request.user?.id)
    deleteUserSessions(app.db, id)
    // 同时拆除该用户仍在运行的任何子 DSH —— 会话虽然没了，
    // 进程 + 转发器也不能继续残留。
    app.supervisor.stop(id)
    audit(app.db, request.user?.id ?? null, 'disable', JSON.stringify({ userId: id }))
    return { ok: true }
  })

  app.post('/api/admin/users/:id/enable', { preHandler: requireAdmin }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const user = findUserById(app.db, id)
    if (user === undefined) return reply.code(404).send({ error: 'not_found' })
    if (user.role !== 'disabled') return reply.code(409).send({ error: 'not_disabled' })
    setUserRole(app.db, id, 'active', request.user?.id)
    audit(app.db, request.user?.id ?? null, 'enable', JSON.stringify({ userId: id }))
    return { ok: true }
  })

  app.post(
    '/api/admin/users/:id/reset-password',
    { preHandler: requireAdmin, schema: passwordBodySchema },
    async (request, reply) => {
      const { id } = request.params as { id: string }
      const { newPassword } = request.body as { newPassword: string }
      const user = findUserById(app.db, id)
      if (user === undefined) return reply.code(404).send({ error: 'not_found' })
      updateUserPassword(app.db, id, await hashPassword(newPassword))
      // 重置后旧密码作废，全部既有会话（含属主自己的）一并吊销。
      deleteUserSessions(app.db, id)
      app.supervisor.stop(id)
      audit(app.db, request.user?.id ?? null, 'password_reset', JSON.stringify({ userId: id }))
      return { ok: true }
    },
  )

  app.post('/api/admin/users/:id/delete', { preHandler: requireAdmin }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const user = findUserById(app.db, id)
    if (user === undefined) return reply.code(404).send({ error: 'not_found' })
    if (id === request.user?.id) return reply.code(409).send({ error: 'cannot_delete_self' })
    if (user.role === 'admin') return reply.code(409).send({ error: 'cannot_delete_admin' })
    // 先停进程再删数据：运行中的子 DSH 持有 home 下的打开文件，
    // 且不能让已删除的用户继续占用端口/转发器。
    app.supervisor.stop(id)
    // 审计先落（用户名存证），再动数据 —— 删除后 actor_name 联表
    // 不再可得，detail 是唯一痕迹。
    audit(app.db, request.user?.id ?? null, 'user_delete', JSON.stringify({ userId: id, username: user.username }))
    // 删文件在前、删行在后：rm 失败时保留用户行可重试；行先删则
    // 失败的 rm 会留下无主目录且无法再定位。
    await rm(join(app.config.dataRoot, 'users', id), { recursive: true, force: true })
    deleteUser(app.db, id)
    return { ok: true }
  })

  app.get('/api/admin/settings', { preHandler: requireAdmin }, async () => {
    const inviteCode = getSetting(app.db, SETTING_INVITE_CODE) ?? ''
    return {
      allowRegister: registrationOpen(app.db),
      inviteRequired: inviteRequired(app.db),
      inviteCode,
    }
  })

  const settingsSchema = {
    body: {
      type: 'object',
      additionalProperties: false,
      properties: {
        allowRegister: { type: 'boolean' },
        // 空串 = 清除邀请码（不再要求）。
        inviteCode: { type: 'string', maxLength: 64 },
      },
    },
  } as const

  app.put(
    '/api/admin/settings',
    { preHandler: requireAdmin, schema: settingsSchema },
    async (request) => {
      const body = request.body as { allowRegister?: boolean; inviteCode?: string }
      if (body.allowRegister !== undefined) {
        setSetting(app.db, SETTING_ALLOW_REGISTER, body.allowRegister ? 'true' : 'false')
      }
      if (body.inviteCode !== undefined) {
        setSetting(app.db, SETTING_INVITE_CODE, body.inviteCode.trim())
      }
      audit(app.db, request.user?.id ?? null, 'settings_update', JSON.stringify(body))
      const inviteCode = getSetting(app.db, SETTING_INVITE_CODE) ?? ''
      return {
        allowRegister: registrationOpen(app.db),
        inviteRequired: inviteRequired(app.db),
        inviteCode,
      }
    },
  )

  app.get('/api/admin/audit', { preHandler: requireAdmin }, async (request) => {
    const query = request.query as { page?: string; limit?: string; actor?: string; action?: string }
    const page = Math.max(1, Number.parseInt(query.page ?? '1', 10) || 1)
    const limit = Math.min(200, Math.max(1, Number.parseInt(query.limit ?? '50', 10) || 50))
    return listAudit(app.db, {
      limit,
      offset: (page - 1) * limit,
      actor: query.actor,
      action: query.action,
    })
  })
}
