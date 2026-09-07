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
  created_at: number
}

/** 可安全通过网络返回的用户结构。 */
export interface PublicUser {
  id: string
  username: string
  role: UserRole
  createdAt: number
}

const USER_COLS = 'id, username, pass_hash, role, created_at'

function toUser(row: Record<string, unknown>): User {
  return {
    id: row.id as string,
    username: row.username as string,
    pass_hash: row.pass_hash as string,
    role: row.role as UserRole,
    created_at: row.created_at as number,
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
}

export function createUser(db: Database, input: CreateUserInput): User {
  const createdAt = Date.now()
  prepare(db,
    'INSERT INTO users (id, username, pass_hash, role, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(input.id, input.username, input.passHash, input.role, createdAt)
  return {
    id: input.id,
    username: input.username,
    pass_hash: input.passHash,
    role: input.role,
    created_at: createdAt,
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

export function setUserRole(db: Database, id: string, role: UserRole): boolean {
  const info = prepare(db, 'UPDATE users SET role = ? WHERE id = ?').run(role, id)
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

/** 带更新时间的设置读取（需要展示「最近修改」时用）。 */
export function getSettingRow(db: Database, key: string): { value: string; updatedAt: number } | undefined {
  const row = prepare(db, 'SELECT value, updated_at FROM app_settings WHERE key = ?').get(key) as
    | { value: string; updated_at: number }
    | undefined
  return row === undefined ? undefined : { value: row.value, updatedAt: row.updated_at }
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
    `SELECT u.id, u.username, u.pass_hash, u.role, u.created_at,
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

/** 市场条目行（`warnings`/`validation`/`disclosure`/`pack_meta` 为 JSON 字符串；
 * 后三者为空串 = 未采集）。`shared` = 管理员推送全员（仅技能/预设）。 */
export interface MarketItemRow {
  id: string
  kind: 'cordis-plugin' | 'skill' | 'agent-preset'
  name: string
  version: string
  description: string
  dir: string
  warnings: string
  validation: string
  disclosure: string
  packMeta: string
  shared: boolean
  importedAt: number
}

const MARKET_COLS = 'id, kind, name, version, description, dir, warnings, validation, disclosure, pack_meta, shared, imported_at'

function toMarketItem(row: Record<string, unknown>): MarketItemRow {
  return {
    id: row.id as string,
    kind: row.kind as MarketItemRow['kind'],
    name: row.name as string,
    version: row.version as string,
    description: row.description as string,
    dir: row.dir as string,
    warnings: row.warnings as string,
    validation: (row.validation as string | undefined) ?? '',
    disclosure: (row.disclosure as string | undefined) ?? '',
    packMeta: (row.pack_meta as string | undefined) ?? '',
    shared: row.shared === 1 || row.shared === true,
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

export interface InsertMarketItemInput {
  id: string
  kind: MarketItemRow['kind']
  name: string
  version: string
  description: string
  dir: string
  warnings: string
  validation?: string
  disclosure?: string
  packMeta?: string
}

export function insertMarketItem(db: Database, input: InsertMarketItemInput): void {
  prepare(db, `
    INSERT INTO market_items (id, kind, name, version, description, dir, warnings, validation, disclosure, pack_meta, imported_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.id,
    input.kind,
    input.name,
    input.version,
    input.description,
    input.dir,
    input.warnings,
    input.validation ?? '',
    input.disclosure ?? '',
    input.packMeta ?? '',
    Date.now(),
  )
}

/** 重新导入同 kind+name+version：指向新目录并刷新元数据。 */
export function updateMarketItem(
  db: Database,
  id: string,
  meta: { description: string; dir: string; warnings: string; validation?: string; disclosure?: string; packMeta?: string },
): void {
  prepare(db, `
    UPDATE market_items SET
      description = ?, dir = ?, warnings = ?,
      validation = COALESCE(?, validation),
      disclosure = COALESCE(?, disclosure),
      pack_meta  = COALESCE(?, pack_meta),
      imported_at = ?
    WHERE id = ?
  `).run(
    meta.description,
    meta.dir,
    meta.warnings,
    meta.validation ?? null,
    meta.disclosure ?? null,
    meta.packMeta ?? null,
    Date.now(),
    id,
  )
}

/** 只刷新校验结论（管理台手动重跑 `--dump-config` 校验），不动其余元数据。 */
export function updateMarketItemValidation(db: Database, id: string, validation: string): boolean {
  const info = prepare(db, 'UPDATE market_items SET validation = ? WHERE id = ?').run(validation, id)
  return info.changes > 0
}

export function deleteMarketItemRow(db: Database, id: string): boolean {
  const info = prepare(db, 'DELETE FROM market_items WHERE id = ?').run(id)
  return info.changes > 0
}

/** 切换条目的「推送全员」标志（仅技能/预设；调用方负责同步用户 home）。 */
export function setMarketItemShared(db: Database, id: string, shared: boolean): boolean {
  const info = prepare(db, 'UPDATE market_items SET shared = ? WHERE id = ?').run(shared ? 1 : 0, id)
  return info.changes > 0
}

/** 全部「推送全员」的条目（技能/预设；market_install 管线会装进用户 home）。 */
export function listSharedMarketItems(db: Database): MarketItemRow[] {
  const rows = prepare(
    db,
    `SELECT ${MARKET_COLS} FROM market_items WHERE shared = 1 AND kind IN ('skill','agent-preset')`,
  ).all() as Array<Record<string, unknown>>
  return rows.map(toMarketItem)
}

/** 取消推送：该条目在所有用户身上的 shared 安装记录降级回 user
 * （允许自行卸载/升级）。 */
export function demoteUserPluginsToUser(db: Database, marketItemId: string): void {
  prepare(db, "UPDATE user_plugins SET source = 'user' WHERE market_item_id = ? AND source = 'shared'").run(marketItemId)
}

/** 全部市场条目的安装计数（列表页一次聚合，替代逐条目 COUNT）。 */
export function countMarketInstallsAll(db: Database): Map<string, number> {
  const rows = prepare(db, 'SELECT market_item_id, COUNT(*) AS n FROM user_plugins GROUP BY market_item_id').all() as Array<{
    market_item_id: string
    n: number
  }>
  return new Map(rows.map((row) => [row.market_item_id, row.n]))
}

/** 每个 (kind, name) 组合最近导入的版本（用户侧更新检测，
 * 一次聚合替代逐安装行查询）。 */
export function listLatestItemVersions(db: Database): Map<string, MarketItemRow['version']> {
  // SQLite 对 bare column + MAX() 聚合保证取自最大值所在行。
  const rows = prepare(
    db,
    'SELECT kind, name, version, MAX(imported_at) AS latest FROM market_items GROUP BY kind, name',
  ).all() as Array<{ kind: string; name: string; version: string }>
  return new Map(rows.map((row) => [`${row.kind}/${row.name}`, row.version]))
}

/** 用户已安装的市场条目记录。`source`: user = 用户自装；
 * shared = 管理员推送（不可自行卸载，取消推送时降级）。 */
export interface UserPluginRow {
  marketItemId: string
  kind: MarketItemRow['kind']
  name: string
  version: string
  installedAt: number
  source: 'user' | 'shared'
}

const USER_PLUGIN_COLS = 'market_item_id, kind, name, version, installed_at, source'

function toUserPlugin(row: Record<string, unknown>): UserPluginRow {
  return {
    marketItemId: row.market_item_id as string,
    kind: row.kind as UserPluginRow['kind'],
    name: row.name as string,
    version: row.version as string,
    installedAt: row.installed_at as number,
    source: row.source === 'shared' ? 'shared' : 'user',
  }
}

export function listUserPlugins(db: Database, userId: string): UserPluginRow[] {
  const rows = prepare(db, `
    SELECT ${USER_PLUGIN_COLS}
    FROM user_plugins WHERE user_id = ? ORDER BY installed_at DESC
  `).all(userId) as Array<Record<string, unknown>>
  return rows.map(toUserPlugin)
}

export function findUserPluginByName(db: Database, userId: string, name: string): UserPluginRow | undefined {
  const row = prepare(db, `
    SELECT ${USER_PLUGIN_COLS}
    FROM user_plugins WHERE user_id = ? AND name = ?
  `).get(userId, name) as Record<string, unknown> | undefined
  return row === undefined ? undefined : toUserPlugin(row)
}

export function upsertUserPlugin(
  db: Database,
  userId: string,
  input: { marketItemId: string; kind: MarketItemRow['kind']; name: string; version: string; source?: 'user' | 'shared' },
): void {
  prepare(db, `
    INSERT INTO user_plugins (user_id, market_item_id, kind, name, version, installed_at, source)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, name) DO UPDATE SET
      market_item_id = excluded.market_item_id,
      kind = excluded.kind,
      version = excluded.version,
      installed_at = excluded.installed_at,
      source = excluded.source
  `).run(userId, input.marketItemId, input.kind, input.name, input.version, Date.now(), input.source ?? 'user')
}

export function removeUserPlugin(db: Database, userId: string, name: string): boolean {
  const info = prepare(db, 'DELETE FROM user_plugins WHERE user_id = ? AND name = ?').run(userId, name)
  return info.changes > 0
}

// ---- 定时 agent 任务 ----------------------------------------------------------

export type TaskScheduleKind = 'interval' | 'daily'
export type TaskRunStatus = 'running' | 'ok' | 'fail' | 'timeout'

/** 定时任务行。排程二选一：interval 用 `intervalMinutes`；daily 用
 * `dailyTime`（本地时间 HH:MM）。 */
export interface ScheduledTaskRow {
  id: string
  userId: string
  name: string
  prompt: string
  scheduleKind: TaskScheduleKind
  intervalMinutes: number | null
  dailyTime: string | null
  enabled: boolean
  createdAt: number
  lastRunAt: number | null
  lastStatus: TaskRunStatus | null
  nextRunAt: number
}

const TASK_COLS =
  'id, user_id, name, prompt, schedule_kind, interval_minutes, daily_time, enabled, created_at, last_run_at, last_status, next_run_at'

function toTask(row: Record<string, unknown>): ScheduledTaskRow {
  return {
    id: row.id as string,
    userId: row.user_id as string,
    name: row.name as string,
    prompt: row.prompt as string,
    scheduleKind: row.schedule_kind as TaskScheduleKind,
    intervalMinutes: (row.interval_minutes as number | null) ?? null,
    dailyTime: (row.daily_time as string | null) ?? null,
    enabled: row.enabled === 1,
    createdAt: row.created_at as number,
    lastRunAt: (row.last_run_at as number | null) ?? null,
    lastStatus: (row.last_status as TaskRunStatus | null) ?? null,
    nextRunAt: row.next_run_at as number,
  }
}

export function insertScheduledTask(db: Database, task: Omit<ScheduledTaskRow, 'lastRunAt' | 'lastStatus'>): void {
  prepare(db, `
    INSERT INTO scheduled_tasks
      (id, user_id, name, prompt, schedule_kind, interval_minutes, daily_time, enabled, created_at, next_run_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    task.id,
    task.userId,
    task.name,
    task.prompt,
    task.scheduleKind,
    task.intervalMinutes,
    task.dailyTime,
    task.enabled ? 1 : 0,
    task.createdAt,
    task.nextRunAt,
  )
}

/** 更新任务定义并重排下次运行（编辑/启停共用；nextRunAt 由调用方算好）。
 * `scheduleKind` 及其参数列一并传入时同一条 UPDATE 覆盖排程两列
 * （未用的参数列清 NULL —— 排程是二选一结构，不能用 COALESCE 保留旧值）。 */
export function updateScheduledTask(
  db: Database,
  id: string,
  fields: {
    name?: string
    prompt?: string
    enabled?: boolean
    nextRunAt?: number
    schedule?: { kind: TaskScheduleKind; intervalMinutes: number | null; dailyTime: string | null }
  },
): boolean {
  let info
  if (fields.schedule !== undefined) {
    info = prepare(db, `
      UPDATE scheduled_tasks SET
        name = COALESCE(?, name),
        prompt = COALESCE(?, prompt),
        enabled = COALESCE(?, enabled),
        next_run_at = COALESCE(?, next_run_at),
        schedule_kind = ?,
        interval_minutes = ?,
        daily_time = ?
      WHERE id = ?
    `).run(
      fields.name ?? null,
      fields.prompt ?? null,
      fields.enabled === undefined ? null : fields.enabled ? 1 : 0,
      fields.nextRunAt ?? null,
      fields.schedule.kind,
      fields.schedule.intervalMinutes,
      fields.schedule.dailyTime,
      id,
    )
  } else {
    info = prepare(db, `
      UPDATE scheduled_tasks SET
        name = COALESCE(?, name),
        prompt = COALESCE(?, prompt),
        enabled = COALESCE(?, enabled),
        next_run_at = COALESCE(?, next_run_at)
      WHERE id = ?
    `).run(
      fields.name ?? null,
      fields.prompt ?? null,
      fields.enabled === undefined ? null : fields.enabled ? 1 : 0,
      fields.nextRunAt ?? null,
      id,
    )
  }
  return info.changes > 0
}

/** 调度器触发后回写：last_run_at/last_status/next_run_at。 */
export function recordTaskFired(db: Database, id: string, firedAt: number, nextRunAt: number): void {
  prepare(db, 'UPDATE scheduled_tasks SET last_run_at = ?, next_run_at = ? WHERE id = ?').run(firedAt, nextRunAt, id)
}

export function recordTaskResult(db: Database, id: string, status: TaskRunStatus, at: number): void {
  prepare(db, 'UPDATE scheduled_tasks SET last_status = ?, last_run_at = ? WHERE id = ?').run(status, at, id)
}

export function findScheduledTask(db: Database, id: string): ScheduledTaskRow | undefined {
  const row = prepare(db, `SELECT ${TASK_COLS} FROM scheduled_tasks WHERE id = ?`).get(id) as
    | Record<string, unknown>
    | undefined
  return row === undefined ? undefined : toTask(row)
}

export function listUserTasks(db: Database, userId: string): ScheduledTaskRow[] {
  const rows = prepare(db, `SELECT ${TASK_COLS} FROM scheduled_tasks WHERE user_id = ? ORDER BY created_at DESC`).all(
    userId,
  ) as Array<Record<string, unknown>>
  return rows.map(toTask)
}

/** 到期且启用的任务（调度器 tick 消费；next_run_at 升序）。 */
export function listDueTasks(db: Database, now: number, limit: number): ScheduledTaskRow[] {
  const rows = prepare(db, `
    SELECT ${TASK_COLS} FROM scheduled_tasks
    WHERE enabled = 1 AND next_run_at <= ?
    ORDER BY next_run_at ASC LIMIT ?
  `).all(now, limit) as Array<Record<string, unknown>>
  return rows.map(toTask)
}

export function countUserTasks(db: Database, userId: string): number {
  const row = prepare(db, 'SELECT COUNT(*) AS n FROM scheduled_tasks WHERE user_id = ?').get(userId) as { n: number }
  return row.n
}

export function deleteScheduledTask(db: Database, id: string): boolean {
  const info = prepare(db, 'DELETE FROM scheduled_tasks WHERE id = ?').run(id)
  return info.changes > 0
}

export interface TaskRunRow {
  id: string
  taskId: string
  triggerKind: string
  startedAt: number
  finishedAt: number | null
  status: TaskRunStatus
  detail: string | null
}

export function insertTaskRun(db: Database, run: { id: string; taskId: string; triggerKind: string; startedAt: number }): void {
  prepare(db, 'INSERT INTO scheduled_task_runs (id, task_id, trigger_kind, started_at, status) VALUES (?, ?, ?, ?, ?)').run(
    run.id,
    run.taskId,
    run.triggerKind,
    run.startedAt,
    'running',
  )
}

export function finishTaskRun(
  db: Database,
  id: string,
  result: { finishedAt: number; status: TaskRunStatus; detail?: string | null },
): void {
  prepare(db, 'UPDATE scheduled_task_runs SET finished_at = ?, status = ?, detail = ? WHERE id = ?').run(
    result.finishedAt,
    result.status,
    result.detail ?? null,
    id,
  )
}

export function listTaskRuns(db: Database, taskId: string, limit: number): TaskRunRow[] {
  const rows = prepare(db, `
    SELECT id, task_id, trigger_kind, started_at, finished_at, status, detail
    FROM scheduled_task_runs WHERE task_id = ? ORDER BY started_at DESC LIMIT ?
  `).all(taskId, limit) as Array<Record<string, unknown>>
  return rows.map((row) => ({
    id: row.id as string,
    taskId: row.task_id as string,
    triggerKind: row.trigger_kind as string,
    startedAt: row.started_at as number,
    finishedAt: (row.finished_at as number | null) ?? null,
    status: (row.status as TaskRunStatus) ?? 'running',
    detail: (row.detail as string | null) ?? null,
  }))
}

/** 启动清扫：服务器关停期间「running」状态孤儿运行标记为 fail。 */
export function failStaleRunningRuns(db: Database, at: number): void {
  prepare(db, "UPDATE scheduled_task_runs SET status = 'fail', finished_at = ?, detail = ? WHERE status = 'running'").run(
    at,
    '服务器重启，运行被中断',
  )
}

// ---- 入站 webhook ------------------------------------------------------------

/** webhook 定义行。原始 token 只在创建响应里出现一次；库里只存
 * SHA-256（与登录会话令牌同一套哈希策略）。 */
export interface WebhookRow {
  id: string
  userId: string
  name: string
  prompt: string
  tokenHash: string
  enabled: boolean
  createdAt: number
  lastFiredAt: number | null
}

const WEBHOOK_COLS = 'id, user_id, name, prompt, token_hash, enabled, created_at, last_fired_at'

function toWebhook(row: Record<string, unknown>): WebhookRow {
  return {
    id: row.id as string,
    userId: row.user_id as string,
    name: row.name as string,
    prompt: row.prompt as string,
    tokenHash: row.token_hash as string,
    enabled: row.enabled === 1,
    createdAt: row.created_at as number,
    lastFiredAt: (row.last_fired_at as number | null) ?? null,
  }
}

export function insertWebhook(db: Database, hook: Omit<WebhookRow, 'lastFiredAt'>): void {
  prepare(db, `
    INSERT INTO inbound_webhooks (id, user_id, name, prompt, token_hash, enabled, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(hook.id, hook.userId, hook.name, hook.prompt, hook.tokenHash, hook.enabled ? 1 : 0, hook.createdAt)
}

export function findWebhook(db: Database, id: string): WebhookRow | undefined {
  const row = prepare(db, `SELECT ${WEBHOOK_COLS} FROM inbound_webhooks WHERE id = ?`).get(id) as
    | Record<string, unknown>
    | undefined
  return row === undefined ? undefined : toWebhook(row)
}

/** 按 token 哈希查找（触发热路径；token_hash 有 UNIQUE 索引）。 */
export function findWebhookByTokenHash(db: Database, tokenHash: string): WebhookRow | undefined {
  const row = prepare(db, `SELECT ${WEBHOOK_COLS} FROM inbound_webhooks WHERE token_hash = ?`).get(tokenHash) as
    | Record<string, unknown>
    | undefined
  return row === undefined ? undefined : toWebhook(row)
}

export function listUserWebhooks(db: Database, userId: string): WebhookRow[] {
  const rows = prepare(db, `SELECT ${WEBHOOK_COLS} FROM inbound_webhooks WHERE user_id = ? ORDER BY created_at DESC`).all(
    userId,
  ) as Array<Record<string, unknown>>
  return rows.map(toWebhook)
}

export function countUserWebhooks(db: Database, userId: string): number {
  const row = prepare(db, 'SELECT COUNT(*) AS n FROM inbound_webhooks WHERE user_id = ?').get(userId) as { n: number }
  return row.n
}

export function deleteWebhook(db: Database, id: string): boolean {
  const info = prepare(db, 'DELETE FROM inbound_webhooks WHERE id = ?').run(id)
  return info.changes > 0
}

export function setWebhookEnabled(db: Database, id: string, enabled: boolean): boolean {
  const info = prepare(db, 'UPDATE inbound_webhooks SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id)
  return info.changes > 0
}

export function recordWebhookFired(db: Database, id: string, at: number): void {
  prepare(db, 'UPDATE inbound_webhooks SET last_fired_at = ? WHERE id = ?').run(at, id)
}

export function insertWebhookFireLog(
  db: Database,
  entry: { webhookId: string; firedAt: number; status: string; detail?: string | null },
): void {
  prepare(db, 'INSERT INTO webhook_fire_log (webhook_id, fired_at, status, detail) VALUES (?, ?, ?, ?)').run(
    entry.webhookId,
    entry.firedAt,
    entry.status,
    entry.detail ?? null,
  )
}

export interface WebhookFireLogRow {
  id: number
  firedAt: number
  status: string
  detail: string | null
}

export function listWebhookFireLog(db: Database, webhookId: string, limit: number): WebhookFireLogRow[] {
  const rows = prepare(db, `
    SELECT id, fired_at, status, detail FROM webhook_fire_log
    WHERE webhook_id = ? ORDER BY fired_at DESC LIMIT ?
  `).all(webhookId, limit) as Array<Record<string, unknown>>
  return rows.map((row) => ({
    id: row.id as number,
    firedAt: row.fired_at as number,
    status: row.status as string,
    detail: (row.detail as string | null) ?? null,
  }))
}
