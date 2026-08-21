/**
 * 环回端口守卫：一条 iptables OUTPUT owner 匹配规则，只允许编排器
 * （root）连接到某用户 DSH 的环回 RPC 端口。因为每个用户 DSH 都在共享
 * 的 127.0.0.1 环回上绑定动态端口，否则同主机的本地租户就可以直接
 * `curl` 别人的 DSH，绕过编排器的会话认证。owner 匹配过滤的是
 * *客户端* uid，它只在同主机环回连接的 OUTPUT 链上可见（INPUT 规则
 * 看到的是接收方 DSH 的 uid，无法做选择性拦截）。
 *
 * 仅限 Linux + root；通过 `config.portGuard` 显式开启，在无法应用它的
 * 主机上启用时会大声报错。
 * @module dsh-admin/supervisor/firewall
 */

import { execFileSync } from 'node:child_process'

/** 一个受守卫的环回端口，支持幂等的安装/移除。 */
export interface PortGuard {
  /** 添加 OUTPUT owner 匹配 REJECT 规则（失败时抛出）。 */
  install(port: number): void
  /** 尽力而为地移除规则（规则不存在不算错误）。 */
  remove(port: number): void
}

/** 一次添加/删除的 iptables 参数（不含可执行文件）。 */
function ruleArgs(port: number, action: '-A' | '-D'): string[] {
  return ['-t', 'filter', action, 'OUTPUT', '-p', 'tcp', '--dport', String(port), '-m', 'owner', '!', '--uid-owner', '0', '-j', 'REJECT']
}

/** 本进程是否能够管理环回 OUTPUT 守卫。 */
function canGuard(): boolean {
  return process.platform === 'linux' && typeof process.getuid === 'function' && process.getuid() === 0
}

/**
 * 启用时创建端口守卫，否则返回 undefined。在无法应用它的主机
 * （非 Linux 或非 root）上启用时会大声报错：静默缺失的守卫会让
 * 同租户之间仍能互访对方的 DSH。
 * @param enabled - 部署开关（`config.portGuard`）。
 */
export function createPortGuard(enabled: boolean): PortGuard | undefined {
  if (!enabled) return undefined
  if (!canGuard()) {
    throw new Error('portGuard 需要以 root 运行的 Linux 主机（iptables OUTPUT owner 匹配）')
  }
  const guarded = new Set<number>()
  return {
    install(port) {
      if (guarded.has(port)) return
      execFileSync('iptables', ruleArgs(port, '-A'))
      guarded.add(port)
    },
    remove(port) {
      if (!guarded.has(port)) return
      try {
        execFileSync('iptables', ruleArgs(port, '-D'))
      } catch {
        // 尽力而为的拆除：过期残留的规则会把端口对同租户保持关闭，
        // 这是故障安全的；而已丢失的规则本来就没了。
      } finally {
        guarded.delete(port)
      }
    },
  }
}
