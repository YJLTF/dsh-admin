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

/** 覆盖用户密码哈希（改密/管理员重置共用）。 */
export function updateUserPassword(db: Database, id: string, passHash: string): boolean {
  const info = prepare(db, 'UPDATE users SET pass_hash = ? WHERE id = ?').run(passHash, id)
  return info.changes > 0
}

/** 彻底删除用户行。sessions / workspaces（级联 folder_plugins）/
 * shared_config_state / user_plugins 均带 ON DELETE CASCADE 随行消失；
 * audit_log 有意保留（actor 是普通文本列，不留悬挂引用）。 */
export function deleteUser(db: Database, id: string): boolean {
  // approved_by 指向本用户的行先清引用，否则外键约束会让删除失败。
  prepare(db, 'UPDATE users SET approved_by = NULL WHERE approved_by = ?').run(id)
  const info = prepare(db, 'DELETE FROM users WHERE id = ?').run(id)
  return info.changes > 0
}

/** 运行时应用设置（管理台可改、立即生效，如注册开关）。 */
export function getSetting(db: Database, key: string): string | undefined {
  const row = prepare(db, 'SELECT value FROM app_settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined
  return row?.value
}

export function setSetting(db: Database, key: string, value: string): void {
  prepare(db, `
    INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(key, value, Date.now())
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
  prepare(db, 'DELETE FROM sessions WHERE user_id = ?').run(userId)
}

/** 吊销用户除当前会话外的全部会话（改密后保持本人在线）。 */
export function deleteUserSessionsExcept(db: Database, userId: string, keepTokenHash: string): void {
  prepare(db, 'DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').run(userId, keepTokenHash)
}

/** 吊销指定会话；仅当它属于该用户时生效（防越权吊销他人会话）。 */
export function deleteSessionForUser(db: Database, userId: string, tokenHash: string): boolean {
  const info = prepare(db, 'DELETE FROM sessions WHERE token_hash = ? AND user_id = ?').run(tokenHash, userId)
  return info.changes > 0
}

/** 会话的对外形态（`tokenHash` 兼作稳定 id —— 它是令牌的 SHA-256，
 * 原始令牌从未存储，暴露哈希不构成泄露）。 */
export interface SessionInfo {
  id: string
  createdAt: number
  expiresAt: number
  ip: string | null
  userAgent: string | null
  lastUsedAt: number
}

export function listUserSessions(db: Database, userId: string): SessionInfo[] {
  const rows = prepare(db, `
    SELECT token_hash, created_at, expires_at, ip, user_agent,
           COALESCE(last_used_at, created_at) AS last_used_at
    FROM sessions WHERE user_id = ? ORDER BY last_used_at DESC
  `).all(userId) as Array<Record<string, unknown>>
  return rows.map((row) => ({
    id: row.token_hash as string,
    createdAt: row.created_at as number,
    expiresAt: row.expires_at as number,
    ip: (row.ip as string | null) ?? null,
    userAgent: (row.user_agent as string | null) ?? null,
    lastUsedAt: row.last_used_at as number,
  }))
}

/** 审计条目的对外形态（actor 联出用户名；已删用户为 null）。 */
export interface AuditEntry {
  id: number
  ts: number
  actor: string | null
  actorName: string | null
  action: string
  detail: string | null
}

export interface AuditQuery {
  limit: number
  offset: number
  actor?: string
  action?: string
}

export function listAudit(db: Database, query: AuditQuery): { total: number; rows: AuditEntry[] } {
  const conditions: string[] = []
  const params: Array<string | number> = []
  if (query.actor !== undefined && query.actor !== '') {
    // 界面输入的是用户名；同时兼容直接给 actor id。
    conditions.push('(a.actor = ? OR u.username = ?)')
    params.push(query.actor, query.actor)
  }
  if (query.action !== undefined && query.action !== '') {
    conditions.push('a.action = ?')
    params.push(query.action)
  }
  const where = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : ''
  const total = prepare(
    db,
    `SELECT COUNT(*) AS n FROM audit_log a LEFT JOIN users u ON a.actor = u.id${where}`,
  ).get(...params) as { n: number }
  const rows = prepare(db, `
    SELECT a.id, a.ts, a.actor, a.action, a.detail, u.username AS actor_name
    FROM audit_log a LEFT JOIN users u ON a.actor = u.id${where}
    ORDER BY a.ts DESC, a.id DESC LIMIT ? OFFSET ?
  `).all(...params, query.limit, query.offset) as Array<Record<string, unknown>>
  return {
    total: total.n,
    rows: rows.map((row) => ({
      id: row.id as number,
      ts: row.ts as number,
      actor: (row.actor as string | null) ?? null,
      actorName: (row.actor_name as string | null) ?? null,
      action: row.action as string,
      detail: (row.detail as string | null) ?? null,
    })),
  }
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
  /** 会话上次活跃时间（无记录时为创建时间），供节流回写 last_used_at。 */
  lastUsedAt: number
  user: User
}

/** 单次 join 查询会话及其用户。 */
export function findSessionWithUser(db: Database, tokenHash: string): SessionUser | undefined {
  const row = prepare(
    db,
    `SELECT u.id, u.username, u.pass_hash, u.role, u.home_dir, u.created_at, u.approved_by,
            s.expires_at, COALESCE(s.last_used_at, s.created_at) AS last_used_at
     FROM sessions s JOIN users u ON s.user_id = u.id
     WHERE s.token_hash = ?`,
  ).get(tokenHash) as Record<string, unknown> | undefined
  if (row === undefined) return undefined
  return { expiresAt: row.expires_at as number, lastUsedAt: row.last_used_at as number, user: toUser(row) }
}

/** 回写会话活跃时间（调用方负责节流）。 */
export function touchSession(db: Database, tokenHash: string): void {
  prepare(db, 'UPDATE sessions SET last_used_at = ? WHERE token_hash = ?').run(Date.now(), tokenHash)
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

// ---- 离线插件市场 ------------------------------------------------------------

/** 市场条目行（`warnings` 为 JSON 字符串数组）。 */
export interface MarketItemRow {
  id: string
  kind: 'cordis-plugin' | 'skill' | 'agent-preset'
  name: string
  version: string
  description: string
  dir: string
  warnings: string
  importedAt: number
}

const MARKET_COLS = 'id, kind, name, version, description, dir, warnings, imported_at'

function toMarketItem(row: Record<string, unknown>): MarketItemRow {
  return {
    id: row.id as string,
    kind: row.kind as MarketItemRow['kind'],
    name: row.name as string,
    version: row.version as string,
    description: row.description as string,
    dir: row.dir as string,
    warnings: row.warnings as string,
    importedAt: row.imported_at as number,
  }
}

export function listMarketItems(db: Database): MarketItemRow[] {
  const rows = prepare(
    db,
    `SELECT ${MARKET_COLS} FROM market_items ORDER BY kind ASC, name ASC, imported_at DESC`,
  ).all() as Array<Record<string, unknown>>
  return rows.map(toMarketItem)
}

export function findMarketItemById(db: Database, id: string): MarketItemRow | undefined {
  const row = prepare(db, `SELECT ${MARKET_COLS} FROM market_items WHERE id = ?`).get(id) as
    | Record<string, unknown>
    | undefined
  return row === undefined ? undefined : toMarketItem(row)
}

export function findMarketItemByKnv(
  db: Database,
  kind: string,
  name: string,
  version: string,
): MarketItemRow | undefined {
  const row = prepare(
    db,
    `SELECT ${MARKET_COLS} FROM market_items WHERE kind = ? AND name = ? AND version = ?`,
  ).get(kind, name, version) as Record<string, unknown> | undefined
  return row === undefined ? undefined : toMarketItem(row)
}

/** 同名条目里最近导入的一版（更新检测用）。 */
export function latestMarketItemByName(db: Database, kind: string, name: string): MarketItemRow | undefined {
  const row = prepare(
    db,
    `SELECT ${MARKET_COLS} FROM market_items WHERE kind = ? AND name = ? ORDER BY imported_at DESC LIMIT 1`,
  ).get(kind, name) as Record<string, unknown> | undefined
  return row === undefined ? undefined : toMarketItem(row)
}

export interface InsertMarketItemInput {
  id: string
  kind: MarketItemRow['kind']
  name: string
  version: string
  description: string
  dir: string
  warnings: string
}

export function insertMarketItem(db: Database, input: InsertMarketItemInput): void {
  prepare(db, `
    INSERT INTO market_items (id, kind, name, version, description, dir, warnings, imported_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(input.id, input.kind, input.name, input.version, input.description, input.dir, input.warnings, Date.now())
}

/** 重新导入同 kind+name+version：指向新目录并刷新元数据。 */
export function updateMarketItem(
  db: Database,
  id: string,
  meta: { description: string; dir: string; warnings: string },
): void {
  prepare(db, 'UPDATE market_items SET description = ?, dir = ?, warnings = ?, imported_at = ? WHERE id = ?').run(
    meta.description,
    meta.dir,
    meta.warnings,
    Date.now(),
    id,
  )
}

export function deleteMarketItemRow(db: Database, id: string): boolean {
  const info = prepare(db, 'DELETE FROM market_items WHERE id = ?').run(id)
  return info.changes > 0
}

/** 某市场条目被多少用户安装着（管理台展示）。 */
export function countMarketInstalls(db: Database, marketItemId: string): number {
  const row = prepare(db, 'SELECT COUNT(*) AS n FROM user_plugins WHERE market_item_id = ?').get(marketItemId) as {
    n: number
  }
  return row.n
}

/** 用户已安装的市场条目记录。 */
export interface UserPluginRow {
  marketItemId: string
  kind: MarketItemRow['kind']
  name: string
  version: string
  installedAt: number
}

export function listUserPlugins(db: Database, userId: string): UserPluginRow[] {
  const rows = prepare(db, `
    SELECT market_item_id, kind, name, version, installed_at
    FROM user_plugins WHERE user_id = ? ORDER BY installed_at DESC
  `).all(userId) as Array<Record<string, unknown>>
  return rows.map((row) => ({
    marketItemId: row.market_item_id as string,
    kind: row.kind as UserPluginRow['kind'],
    name: row.name as string,
    version: row.version as string,
    installedAt: row.installed_at as number,
  }))
}

export function findUserPluginByName(db: Database, userId: string, name: string): UserPluginRow | undefined {
  const row = prepare(db, `
    SELECT market_item_id, kind, name, version, installed_at
    FROM user_plugins WHERE user_id = ? AND name = ?
  `).get(userId, name) as Record<string, unknown> | undefined
  if (row === undefined) return undefined
  return {
    marketItemId: row.market_item_id as string,
    kind: row.kind as UserPluginRow['kind'],
    name: row.name as string,
    version: row.version as string,
    installedAt: row.installed_at as number,
  }
}

export function upsertUserPlugin(
  db: Database,
  userId: string,
  input: { marketItemId: string; kind: MarketItemRow['kind']; name: string; version: string },
): void {
  prepare(db, `
    INSERT INTO user_plugins (user_id, market_item_id, kind, name, version, installed_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, name) DO UPDATE SET
      market_item_id = excluded.market_item_id,
      kind = excluded.kind,
      version = excluded.version,
      installed_at = excluded.installed_at
  `).run(userId, input.marketItemId, input.kind, input.name, input.version, Date.now())
}

export function removeUserPlugin(db: Database, userId: string, name: string): boolean {
  const info = prepare(db, 'DELETE FROM user_plugins WHERE user_id = ? AND name = ?').run(userId, name)
  return info.changes > 0
}
