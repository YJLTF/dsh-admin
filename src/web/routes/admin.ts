/**
 * 管理员路由：列出用户、批准/停用账户。全部由
 * `requireAdmin` 守卫。
 * @module dsh-admin/web/routes/admin
 */

import type { FastifyPluginAsync } from 'fastify'
import { requireAdmin } from '../middleware/authn.js'
import { audit, deleteUserSessions, findUserById, listPublicUsers, setUserRole } from '../../db/repo.js'

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
}
