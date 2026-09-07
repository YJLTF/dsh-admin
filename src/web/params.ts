/**
 * 查询参数解析助手（routes/tasks.ts、routes/webhooks.ts、
 * routes/admin.ts 共用）。
 * @module dsh-admin/web/params
 */

/**
 * 解析 `?limit=` 分页上限。非正数/非法取值回退 `def`（而不是原样
 * 透传 —— SQLite 的 `LIMIT -1` 语义是「无上限」，会让 `?limit=-1`
 * 变成全量查询），并夹紧到 `[1, max]`。
 */
export function parseLimit(raw: unknown, def: number, max: number): number {
  const n = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isFinite(n) || n < 1) return def
  return Math.min(Math.floor(n), max)
}
