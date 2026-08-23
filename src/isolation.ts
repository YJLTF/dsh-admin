/**
 * 账户级隔离辅助函数。仅限 Linux：每个用户映射到一个确定性的
 * OS uid，编排器据此（通过 setuid）以该账户拉起用户的 DSH，
 * 每用户 0700 目录从而成为真正的边界。
 * @module dsh-admin/isolation
 */

/**
 * 由用户 id 确定性导出的 OS uid（跨重启、跨主机稳定）。
 * `baseUid` 应高于发行版的系统 uid 区间（通常 < 1000）。
 *
 * 注意：派生空间为 `baseUid + (hash % 100000)`，不同 userId 可能碰撞
 * （约 120 个用户时期望 1 次碰撞）。碰撞的两个用户会共享 uid —— 在
 * account 模式下等于互访对方目录。部署规模变大时应改用更宽的派生
 * 空间或在建号时显式检测冲突（改动会改变存量 uid，需同步重新
 * provision，见 docs/hard-isolation.md）。
 */
export function uidForUser(userId: string, baseUid: number): number {
  let hash = 0
  for (let i = 0; i < userId.length; i++) hash = (hash * 31 + userId.charCodeAt(i)) >>> 0
  return baseUid + (hash % 100000)
}
