/**
 * 认证路由：自助注册（→ 待审核）、登录、登出与当前身份。
 * 注册始终产生 `pending` 用户；由管理员批准。
 * @module dsh-admin/web/routes/auth
 */

import type { FastifyPluginAsync } from 'fastify'
import { randomUUID } from 'node:crypto'
import { requireAuth } from '../middleware/authn.js'
import {
  audit,
  createSession,
  createUser,
  deleteSession,
  findUserByUsername,
  purgeExpiredSessions,
  toPublicUser,
} from '../../db/repo.js'
import { ensureUserDir, userHomeDir } from '../../fs/workspace.js'
import {
  clearSessionCookie,
  hashPassword,
  hashSessionToken,
  newSessionToken,
  parseCookie,
  sessionCookie,
  verifyPassword,
} from '../auth.js'

const registerSchema = {
  body: {
    type: 'object',
    required: ['username', 'password'],
    additionalProperties: false,
    properties: {
      username: { type: 'string', minLength: 3, maxLength: 32, pattern: '^[a-zA-Z0-9_-]+$' },
      password: { type: 'string', minLength: 8, maxLength: 128 },
    },
  },
} as const

const loginSchema = {
  body: {
    type: 'object',
    required: ['username', 'password'],
    additionalProperties: false,
    properties: {
      username: { type: 'string', maxLength: 64 },
      password: { type: 'string', maxLength: 128 },
    },
  },
} as const

interface Credentials {
  username: string
  password: string
}

export const authRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    '/api/auth/register',
    { schema: registerSchema, config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const { username, password } = request.body as Credentials
      const db = app.db
      if (findUserByUsername(db, username) !== undefined) {
        return reply.code(409).send({ error: 'username_taken' })
      }
      const id = randomUUID()
      const homeDir = userHomeDir(app.config, id)
      await ensureUserDir(homeDir)
      const passHash = await hashPassword(password)
      try {
        createUser(db, { id, username, passHash, role: 'pending', homeDir })
      } catch (err) {
        // 并发注册同名用户：预检查通过但 INSERT 撞 UNIQUE 约束 → 409。
        if ((err as NodeJS.ErrnoException).code?.startsWith('SQLITE_CONSTRAINT')) {
          return reply.code(409).send({ error: 'username_taken' })
        }
        throw err
      }
      audit(db, id, 'register', JSON.stringify({ username }))
      return reply.code(201).send({ user: { id, username, role: 'pending' } })
    },
  )

  app.post(
    '/api/auth/login',
    { schema: loginSchema, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const { username, password } = request.body as Credentials
      const db = app.db
      const user = findUserByUsername(db, username)
      if (user === undefined || !(await verifyPassword(password, user.pass_hash))) {
        return reply.code(401).send({ error: 'invalid_credentials' })
      }
      if (user.role === 'pending') return reply.code(403).send({ error: 'pending_review' })
      if (user.role === 'disabled') return reply.code(403).send({ error: 'disabled' })

      const token = newSessionToken()
      // 把过期会话清理搭在登录上（低频操作，让表不会无限增长，
      // 省去单独的清扫器）。
      purgeExpiredSessions(db)
      createSession(db, {
        tokenHash: hashSessionToken(token),
        userId: user.id,
        expiresAt: Date.now() + app.config.sessionTtlSeconds * 1000,
        ip: request.ip,
        userAgent: request.headers['user-agent'],
      })
      audit(db, user.id, 'login', null)
      reply.header('set-cookie', sessionCookie(token, app.config.sessionTtlSeconds))
      return { user: toPublicUser(user) }
    },
  )

  app.post('/api/auth/logout', async (request, reply) => {
    const token = parseCookie(request.headers.cookie, 'sid')
    if (token !== undefined) deleteSession(app.db, hashSessionToken(token))
    reply.header('set-cookie', clearSessionCookie())
    return { ok: true }
  })

  app.get('/api/auth/me', { preHandler: requireAuth }, async (request) => ({ user: request.user }))
}
