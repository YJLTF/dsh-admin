/**
 * 认证 / 授权守卫。
 *
 * `requireAuth` 通过一次 `sessions JOIN users` 查询把会话 cookie 解析为
 * `request.user`（一个 PublicUser）；`requireAdmin` 在此基础上追加
 * 管理员角色校验。两者分别以 401/403 拒绝，绝不继续执行处理器。
 * @module dsh-admin/web/middleware/authn
 */

import type { FastifyReply, FastifyRequest } from 'fastify'
import { findSessionWithUser, toPublicUser, touchSession } from '../../db/repo.js'
import { hashSessionToken, parseCookie } from '../auth.js'

/** last_used_at 回写节流窗口：同会话 60 秒内最多写一次，
 * 认证热路径基本零额外开销。 */
const TOUCH_INTERVAL_MS = 60_000

/** 把会话 cookie 解析为 `request.user`，否则以 401 拒绝。 */
export async function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const token = parseCookie(request.headers.cookie, 'sid')
  if (token === undefined) {
    reply.code(401).send({ error: 'unauthorized' })
    return
  }
  const tokenHash = hashSessionToken(token)
  const row = findSessionWithUser(request.server.db, tokenHash)
  if (row === undefined || row.expiresAt <= Date.now() || row.user.role === 'disabled') {
    reply.code(401).send({ error: 'unauthorized' })
    return
  }
  if (Date.now() - row.lastUsedAt > TOUCH_INTERVAL_MS) touchSession(request.server.db, tokenHash)
  request.user = toPublicUser(row.user)
}

/** 要求已认证的管理员；非管理员以 403 拒绝。 */
export async function requireAdmin(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  await requireAuth(request, reply)
  if (request.user === null) return // requireAuth 已发送响应
  if (request.user.role !== 'admin') {
    reply.code(403).send({ error: 'forbidden' })
    return
  }
}
