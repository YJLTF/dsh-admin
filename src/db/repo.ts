/**
 * 基于 SQLite 连接的用户 / 会话 / 审计数据访问。
 *
 * 所有访问均为参数化（预处理语句）。函数显式接收连接，因此不依赖
 * Fastify/应用状态，便于测试。
 * @module dsh-admin/db/repo
 */

import { randomUUID } from 'node:crypto'
import type { Database } from './connection.js'
import { prepare } from './prepared.js'

export type UserRole = 'admin' | 'pending' | 'active' | 'disabled'

/** 完整的用户行，包含机密（绝不序列化给客户端）。 */
export interface User {
  id: string
  username: string
  pass_hash: string
  role: UserRole
  home_dir: string
  created_at: number
  approved_by: string | null
}

/** 可安全通过网络返回的用户结构。 */
export interface PublicUser {
  id: string
  username: string
  role: UserRole
  createdAt: number
}

const USER_COLS = 'id, username, pass_hash, role, home_dir, created_at, approved_by'

function toUser(row: Record<string, unknown>): User {
  return {
    id: row.id as string,
    username: row.username as string,
    pass_hash: row.pass_hash as string,
    role: row.role as UserRole,
    home_dir: row.home_dir as string,
    created_at: row.created_at as number,
    approved_by: (row.approved_by as string | null) ?? null,
  }
}

export function toPublicUser(user: User): PublicUser {
  return { id: user.id, username: user.username, role: user.role, createdAt: user.created_at }
}

export interface CreateUserInput {
  id: string
  username: string
  passHash: string
  role: UserRole
  homeDir: string
}

export function createUser(db: Database, input: CreateUserInput): User {
  const createdAt = Date.now()
  prepare(db,
    'INSERT INTO users (id, username, pass_hash, role, home_dir, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(input.id, input.username, input.passHash, input.role, input.homeDir, createdAt)
  return {
    id: input.id,
    username: input.username,
    pass_hash: input.passHash,
    role: input.role,
    home_dir: input.homeDir,
    created_at: createdAt,
    approved_by: null,
  }
}

export function findUserByUsername(db: Database, username: string): User | undefined {
  const row = prepare(db,`SELECT ${USER_COLS} FROM users WHERE username = ?`).get(username)
  return row ? toUser(row as Record<string, unknown>) : undefined
}

export function findUserById(db: Database, id: string): User | undefined {
  const row = prepare(db,`SELECT ${USER_COLS} FROM users WHERE id = ?`).get(id)
  return row ? toUser(row as Record<string, unknown>) : undefined
}

export function listPublicUsers(db: Database): PublicUser[] {
  const rows = prepare(db,`SELECT ${USER_COLS} FROM users ORDER BY created_at ASC`).all() as Array<
    Record<string, unknown>
  >
  return rows.map((row) => toPublicUser(toUser(row)))
}

export function countAdmins(db: Database): number {
  const row = prepare(db,`SELECT COUNT(*) AS n FROM users WHERE role = 'admin'`).get() as { n: number }
  return row.n
}

export function setUserRole(db: Database, id: string, role: UserRole, approvedBy?: string): boolean {
  const info =
    approvedBy === undefined
      ? prepare(db,'UPDATE users SET role = ? WHERE id = ?').run(role, id)
      : prepare(db,'UPDATE users SET role = ?, approved_by = ? WHERE id = ?').run(role, approvedBy, id)
  return info.changes > 0
}

export interface CreateSessionInput {
  tokenHash: string
  userId: string
  expiresAt: number
  ip?: string
  userAgent?: string
}

export function createSession(db: Database, input: CreateSessionInput): void {
  prepare(db,
    'INSERT INTO sessions (token_hash, user_id, created_at, expires_at, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(input.tokenHash, input.userId, Date.now(), input.expiresAt, input.ip ?? null, input.userAgent ?? null)
}

export function deleteSession(db: Database, tokenHash: string): void {
  prepare(db,'DELETE FROM sessions WHERE token_hash = ?').run(tokenHash)
}

export function deleteUserSessions(db: Database, userId: string): void {
  prepare(db,'DELETE FROM sessions WHERE user_id = ?').run(userId)
}

/** 清除过期会话（超过 TTL 的行不会再为任何人服务）。 */
export function purgeExpiredSessions(db: Database): void {
  prepare(db, 'DELETE FROM sessions WHERE expires_at < ?').run(Date.now())
}

/** 追加一条审计记录。`actor` 为用户 id 或 `'system'`。 */
export function audit(db: Database, actor: string | null, action: string, detail?: string | null): void {
  prepare(db,'INSERT INTO audit_log (ts, actor, action, detail) VALUES (?, ?, ?, ?)').run(
    Date.now(),
    actor,
    action,
    detail ?? null,
  )
}

/** 每用户项目文件夹（工作区）的一行。 */
export interface Workspace {
  id: string
  userId: string
  name: string
  relPath: string
  createdAt: number
}

function toWorkspace(row: Record<string, unknown>): Workspace {
  return {
    id: row.id as string,
    userId: row.user_id as string,
    name: row.name as string,
    relPath: row.rel_path as string,
    createdAt: row.created_at as number,
  }
}

export function findWorkspaceByPath(db: Database, userId: string, relPath: string): Workspace | undefined {
  const row = prepare(db, 'SELECT id, user_id, name, rel_path, created_at FROM workspaces WHERE user_id = ? AND rel_path = ?')
    .get(userId, relPath)
  return row ? toWorkspace(row as Record<string, unknown>) : undefined
}

/** 按（用户, relPath） upsert 一行工作区；创建时使用派生名称。 */
export function getOrCreateWorkspace(db: Database, userId: string, relPath: string): Workspace {
  const existing = findWorkspaceByPath(db, userId, relPath)
  if (existing !== undefined) return existing
  const id = randomUUID()
  const segments = relPath.split('/').filter(Boolean)
  const name = segments.at(-1) ?? 'root'
  const createdAt = Date.now()
  const info = prepare(db,
    'INSERT INTO workspaces (id, user_id, name, rel_path, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (user_id, rel_path) DO NOTHING',
  ).run(id, userId, name, relPath, createdAt)
  if (info.changes === 0) {
    // 并发创建：另一路已插入同一 (user_id, rel_path)，复用那一行。
    const concurrent = findWorkspaceByPath(db, userId, relPath)
    if (concurrent !== undefined) return concurrent
  }
  return { id, userId, name, relPath, createdAt }
}

/** 替换工作区的插件选择（单事务内先删后插）。 */
export function setFolderPlugins(
  db: Database,
  workspaceId: string,
  selections: ReadonlyArray<{ id: string; enabled: boolean }>,
): void {
  const tx = db.transaction(() => {
    prepare(db,'DELETE FROM folder_plugins WHERE workspace_id = ?').run(workspaceId)
    const insert = prepare(db,
      'INSERT INTO folder_plugins (workspace_id, plugin_id, enabled, updated_at) VALUES (?, ?, ?, ?)',
    )
    for (const selection of selections) {
      insert.run(workspaceId, selection.id, selection.enabled ? 1 : 0, Date.now())
    }
  })
  tx()
}

/** 某工作区已启用的插件 id 列表。 */
export function getEnabledPluginIds(db: Database, workspaceId: string): string[] {
  const rows = prepare(db, 'SELECT plugin_id FROM folder_plugins WHERE workspace_id = ? AND enabled = 1')
    .all(workspaceId) as Array<{ plugin_id: string }>
  return rows.map((row) => row.plugin_id)
}

/** 会话与其用户的联表结果，供认证热路径使用（单次查询）。 */
export interface SessionUser {
  expiresAt: number
  user: User
}

/** 单次 join 查询会话及其用户。 */
export function findSessionWithUser(db: Database, tokenHash: string): SessionUser | undefined {
  const row = prepare(
    db,
    `SELECT u.id, u.username, u.pass_hash, u.role, u.home_dir, u.created_at, u.approved_by,
            s.expires_at
     FROM sessions s JOIN users u ON s.user_id = u.id
     WHERE s.token_hash = ?`,
  ).get(tokenHash) as Record<string, unknown> | undefined
  if (row === undefined) return undefined
  return { expiresAt: row.expires_at as number, user: toUser(row) }
}

/** 单例的管理员维护共享配置行（payload 为原始 JSON）。 */
export interface SharedConfigRow {
  payload: string
  version: number
  updatedAt: number
}

/** 读取共享配置；管理员从未保存过时为 `undefined`。 */
export function getSharedConfig(db: Database): SharedConfigRow | undefined {
  const row = prepare(db, 'SELECT payload, version, updated_at FROM shared_config WHERE id = 1').get() as
    | { payload: string; version: number; updated_at: number }
    | undefined
  return row === undefined ? undefined : { payload: row.payload, version: row.version, updatedAt: row.updated_at }
}

/** 保存共享配置并递增版本号（让已接受的用户重新收到提示）。 */
export function setSharedConfig(db: Database, payload: string): SharedConfigRow {
  const row = prepare(db, `
    INSERT INTO shared_config (id, payload, version, updated_at) VALUES (1, ?, 1, ?)
    ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, version = version + 1, updated_at = excluded.updated_at
    RETURNING payload, version, updated_at
  `).get(payload, Date.now()) as { payload: string; version: number; updated_at: number }
  return { payload: row.payload, version: row.version, updatedAt: row.updated_at }
}

/** 用户的接受记录；`appliedPayload` 是最近一次写入其 DSH 主目录的内容。 */
export interface SharedConfigState {
  acceptedVersion: number
  appliedPayload: string
  acceptedAt: number
}

export function getSharedConfigState(db: Database, userId: string): SharedConfigState | undefined {
  const row = prepare(
    db,
    'SELECT accepted_version, applied_payload, accepted_at FROM shared_config_state WHERE user_id = ?',
  ).get(userId) as { accepted_version: number; applied_payload: string; accepted_at: number } | undefined
  return row === undefined
    ? undefined
    : { acceptedVersion: row.accepted_version, appliedPayload: row.applied_payload, acceptedAt: row.accepted_at }
}

/** 记录（或覆盖）用户对当前共享配置的接受。 */
export function setSharedConfigState(
  db: Database,
  userId: string,
  acceptedVersion: number,
  appliedPayload: string,
): void {
  prepare(db, `
    INSERT INTO shared_config_state (user_id, accepted_version, applied_payload, accepted_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      accepted_version = excluded.accepted_version,
      applied_payload = excluded.applied_payload,
      accepted_at = excluded.accepted_at
  `).run(userId, acceptedVersion, appliedPayload, Date.now())
}

/** 当前有多少用户在跟随共享配置。 */
export function countSharedConfigAcceptances(db: Database): number {
  const row = prepare(db, 'SELECT COUNT(*) AS n FROM shared_config_state').get() as { n: number }
  return row.n
}
