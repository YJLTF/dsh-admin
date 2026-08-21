/**
 * 账户级隔离辅助函数。仅限 Linux：每个用户映射到一个确定性的
 * OS uid，编排器据此（通过 setuid）以该账户拉起用户的 DSH，
 * 每用户 0700 目录从而成为真正的边界。
 * @module dsh-admin/isolation
 */

/**
 * 由用户 id 确定性导出的 OS uid（跨重启、跨主机稳定）。
 * `baseUid` 应高于发行版的系统 uid 区间（通常 < 1000）。
 */
export function uidForUser(userId: string, baseUid: number): number {
  let hash = 0
  for (let i = 0; i < userId.length; i++) hash = (hash * 31 + userId.charCodeAt(i)) >>> 0
  return baseUid + (hash % 100000)
}
