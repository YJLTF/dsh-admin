/**
 * 运维路由：健康检查（公开）与管理台的全局实例视图、单停实例和
 * 每用户磁盘用量。实例数据来自编排器内存状态，无需落库。
 * @module dsh-admin/web/routes/ops
 */

import type { FastifyPluginAsync } from 'fastify'
import { requireAdmin } from '../middleware/authn.js'
import { audit, listPublicUsers } from '../../db/repo.js'
import { dirUsage } from '../../fs/storage.js'
import { userHomeDir, workspaceRoot } from '../../fs/workspace.js'

/** 进程启动时间（uptime 用）。 */
const PROCESS_STARTED_AT = Date.now()

/** 存储统计缓存窗口：全量 du 走遍所有用户 home/workspace，
 * 请求风暴下逐次重算既慢又压磁盘。 */
const STORAGE_TTL_MS = 60_000

interface StorageReport {
  users: Array<{ userId: string; username: string; homeBytes: number; wsBytes: number; totalBytes: number }>
  totalBytes: number
  computedAt: number
}

let storageCache: StorageReport | null = null

async function computeStorage(app: {
  db: import('../../db/connection.js').Database
  config: import('../../config.js').ServerConfig
}): Promise<StorageReport> {
  const users: StorageReport['users'] = []
  let totalBytes = 0
  // 逐用户串行：du 是 I/O 密集型，百用户规模并发展开会同时压所有目录树。
  for (const user of listPublicUsers(app.db)) {
    const home = await dirUsage(userHomeDir(app.config, user.id))
    const ws = await dirUsage(workspaceRoot(app.config, user.id))
    users.push({ userId: user.id, username: user.username, homeBytes: home, wsBytes: ws, totalBytes: home + ws })
    totalBytes += home + ws
  }
  users.sort((a, b) => b.totalBytes - a.totalBytes)
  return { users, totalBytes, computedAt: Date.now() }
}

export const opsRoutes: FastifyPluginAsync = async (app) => {
  // 公开健康检查：只暴露可用性与最小计数，不泄露用户/路径信息。
  // 关闭限流让 Docker HEALTHCHECK 高频探测不被节流。
  app.get('/healthz', { config: { rateLimit: false } }, async () => ({
    ok: true,
    uptimeSec: Math.floor((Date.now() - PROCESS_STARTED_AT) / 1000),
    instanceCount: app.supervisor.listInstances().length,
  }))

  app.get('/api/admin/instances', { preHandler: requireAdmin }, async () => {
    const byId = new Map(listPublicUsers(app.db).map((user) => [user.id, user.username]))
    return {
      instances: app.supervisor.listInstances().map((instance) => ({
        ...instance,
        username: byId.get(instance.userId) ?? instance.userId,
      })),
    }
  })

  app.post('/api/admin/instances/:userId/stop', { preHandler: requireAdmin }, async (request, reply) => {
    const { userId } = request.params as { userId: string }
    if (app.supervisor.status(userId).main === undefined) {
      return reply.code(404).send({ error: 'not_running' })
    }
    // 只停实例不动账号 —— 与 disable（禁号 + 停实例）不同，用户可自行重新启动。
    app.supervisor.stop(userId)
    audit(app.db, request.user?.id ?? null, 'instance_stop', JSON.stringify({ userId }))
    return { ok: true }
  })

  app.get('/api/admin/storage', { preHandler: requireAdmin }, async (request) => {
    const refresh = (request.query as { refresh?: string }).refresh === '1'
    if (refresh || storageCache === null || Date.now() - storageCache.computedAt > STORAGE_TTL_MS) {
      storageCache = await computeStorage(app)
    }
    return storageCache
  })
}
