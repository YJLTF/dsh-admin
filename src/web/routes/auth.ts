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
  deleteSessionForUser,
  deleteUserSessionsExcept,
  findUserByUsername,
  findUserById,
  getSetting,
  listUserSessions,
  purgeExpiredSessions,
  toPublicUser,
  updateUserPassword,
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

/** 运行时注册开关（app_settings；缺省 = 开放注册）。 */
export const SETTING_ALLOW_REGISTER = 'allowRegister'
/** 注册邀请码（app_settings；缺省/空 = 不要求邀请码）。 */
export const SETTING_INVITE_CODE = 'inviteCode'

export function registrationOpen(db: Parameters<typeof getSetting>[0]): boolean {
  return getSetting(db, SETTING_ALLOW_REGISTER) !== 'false'
}

/** 当前是否要求注册邀请码（设置过非空值即要求）。 */
export function inviteRequired(db: Parameters<typeof getSetting>[0]): boolean {
  const code = getSetting(db, SETTING_INVITE_CODE)
  return code !== undefined && code !== ''
}

const registerSchema = {
  body: {
    type: 'object',
    required: ['username', 'password'],
    additionalProperties: false,
    properties: {
      username: { type: 'string', minLength: 3, maxLength: 32, pattern: '^[a-zA-Z0-9_-]+$' },
      password: { type: 'string', minLength: 8, maxLength: 128 },
      inviteCode: { type: 'string', minLength: 1, maxLength: 64 },
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
      const { username, password, inviteCode } = request.body as Credentials & { inviteCode?: string }
      const db = app.db
      if (!registrationOpen(db)) {
        return reply.code(403).send({ error: 'registrations_disabled' })
      }
      if (inviteRequired(db) && inviteCode !== getSetting(db, SETTING_INVITE_CODE)) {
        return reply.code(403).send({ error: 'invalid_invite' })
      }
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

  // 注册页适配（公开）：是否开放注册、是否需要邀请码。
  app.get('/api/meta', async (request) => ({
    allowRegister: registrationOpen(app.db),
    inviteRequired: inviteRequired(app.db),
  }))

  const changePasswordSchema = {
    body: {
      type: 'object',
      required: ['currentPassword', 'newPassword'],
      additionalProperties: false,
      properties: {
        currentPassword: { type: 'string', minLength: 1, maxLength: 128 },
        newPassword: { type: 'string', minLength: 8, maxLength: 128 },
      },
    },
  } as const

  app.post(
    '/api/me/password',
    { preHandler: requireAuth, schema: changePasswordSchema, config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const { currentPassword, newPassword } = request.body as { currentPassword: string; newPassword: string }
      const db = app.db
      const user = findUserById(db, request.user!.id)
      if (user === undefined || !(await verifyPassword(currentPassword, user.pass_hash))) {
        return reply.code(401).send({ error: 'invalid_credentials' })
      }
      updateUserPassword(db, user.id, await hashPassword(newPassword))
      // 改密后吊销其他设备的会话，当前会话保持在线。
      const token = parseCookie(request.headers.cookie, 'sid')
      if (token !== undefined) deleteUserSessionsExcept(db, user.id, hashSessionToken(token))
      audit(db, user.id, 'password_change', null)
      return { ok: true }
    },
  )

  app.get('/api/me/sessions', { preHandler: requireAuth }, async (request) => {
    const token = parseCookie(request.headers.cookie, 'sid')
    const currentId = token !== undefined ? hashSessionToken(token) : null
    return { sessions: listUserSessions(app.db, request.user!.id), currentId }
  })

  app.delete('/api/me/sessions/:tokenHash', { preHandler: requireAuth }, async (request, reply) => {
    const { tokenHash } = request.params as { tokenHash: string }
    if (!deleteSessionForUser(app.db, request.user!.id, tokenHash)) {
      return reply.code(404).send({ error: 'not_found' })
    }
    // 吊销的若是当前会话，同步清 cookie 让前端立即回到登录页。
    const token = parseCookie(request.headers.cookie, 'sid')
    if (token !== undefined && hashSessionToken(token) === tokenHash) {
      reply.header('set-cookie', clearSessionCookie())
    }
    audit(app.db, request.user!.id, 'session_revoke', null)
    return { ok: true }
  })
}
