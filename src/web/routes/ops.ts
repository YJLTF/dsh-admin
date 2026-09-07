/**
 * 运维路由：健康检查（公开）与管理台的全局实例视图、单停实例、
 * 每用户磁盘用量，以及 dsh CLI 的平台内热更新（上传 tgz → 挂载目录
 * 内解包校验 → 原子替换 node_modules，见 fs/dsh-cli.ts）。实例数据
 * 来自编排器内存状态，无需落库。
 * @module dsh-admin/web/routes/ops
 */

import type { FastifyPluginAsync } from 'fastify'
import { randomBytes } from 'node:crypto'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { requireAdmin } from '../middleware/authn.js'
import { saveSelectedFileParts } from '../multipart.js'
import { audit, listPublicUsers } from '../../db/repo.js'
import { dirUsage } from '../../fs/storage.js'
import { userHomeDir, workspaceRoot } from '../../fs/workspace.js'
import { InvalidCliArchiveError, readDshCliInfo, updateDshCli } from '../../fs/dsh-cli.js'

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
      dshVersion: await app.supervisor.dshVersion(),
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

  // ---------- dsh CLI 平台内热更新 ----------

  /** CLI 目录状态：`managed=false` 表示未配置 DSH_ADMIN_DSH_CLI_DIR。
   * `installedVersion`（磁盘上的 package.json）与 `runningVersion`
   * （dsh --version 探测，TTL 缓存）不一致 = 更新已落盘、运行中的
   * 实例仍是旧版。 */
  app.get('/api/admin/dsh-cli', { preHandler: requireAdmin }, async () => {
    const info = await readDshCliInfo(app.config)
    return {
      managed: info !== null,
      cliDir: info?.cliDir ?? '',
      installedVersion: info?.installedVersion ?? null,
      runningVersion: await app.supervisor.dshVersion(),
    }
  })

  /** 上传 dsh-cli.tgz（pack-dsh.ps1 产物）就地更新 CLI。运行中的
   * 实例继续用旧版（进程已映射的文件不受 rename 影响），新拉起的
   * 会话即用新版。 */
  app.post('/api/admin/dsh-cli/update', { preHandler: requireAdmin }, async (request, reply) => {
    if (app.config.dshCliDir === '') {
      return reply.code(400).send({
        error: 'cli_dir_not_configured',
        message: '未设置 DSH_ADMIN_DSH_CLI_DIR，平台无法就地更新 dsh CLI（仍可按部署文档手工解压）',
      })
    }
    if (!request.isMultipart()) return reply.code(400).send({ error: 'expected_multipart' })
    const tmpDir = join(app.config.dataRoot, 'tmp')
    await mkdir(tmpDir, { recursive: true })
    const tmpTgz = join(tmpDir, `dsh-cli-${randomBytes(6).toString('hex')}.tgz`)
    try {
      let sawFile = false
      const saved = await saveSelectedFileParts(request, (_fieldname, fileIndex) => {
        if (fileIndex > 0) return null
        sawFile = true
        return tmpTgz
      })
      if (saved === 'too_large') return reply.code(413).send({ error: 'too_large' })
      if (!sawFile) return reply.code(400).send({ error: 'missing_file' })
      const result = await updateDshCli(app.config, tmpTgz)
      audit(app.db, request.user?.id ?? null, 'dsh_cli_update', JSON.stringify(result))
      return {
        ...result,
        runningUserIds: app.supervisor
          .listInstances()
          .filter((instance) => instance.role === 'main')
          .map((instance) => instance.userId),
      }
    } catch (err) {
      if (err instanceof InvalidCliArchiveError) {
        return reply.code(422).send({ error: 'invalid_cli_archive', message: err.message })
      }
      throw err
    } finally {
      await rm(tmpTgz, { force: true }).catch(() => {})
    }
  })

  /** 停止全部主实例（CLI 更新后让运行中的会话尽快用上新版；账号
   * 不受影响，用户可自行重新启动）。 */
  app.post('/api/admin/instances/stop-all', { preHandler: requireAdmin }, async (request) => {
    const mains = app.supervisor.listInstances().filter((instance) => instance.role === 'main')
    for (const instance of mains) app.supervisor.stop(instance.userId)
    audit(app.db, request.user?.id ?? null, 'instances_stop_all', JSON.stringify({ count: mains.length }))
    return { ok: true, stopped: mains.length }
  })
}
