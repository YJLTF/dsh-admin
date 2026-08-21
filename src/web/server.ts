/**
 * Fastify 引导：组装 HTTP 服务器、注册插件与路由，
 * 并通过 close 钩子持有数据库生命周期。
 * @module dsh-admin/web/server
 */

import Fastify, { type FastifyInstance } from 'fastify'
import fastifyStatic from '@fastify/static'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import type { ServerConfig } from '../config.js'
import { openDatabase, type Database } from '../db/connection.js'
import { type PublicUser } from '../db/repo.js'
import { Supervisor } from '../supervisor/orchestrator.js'
import { rateLimit } from './middleware/rate-limit.js'
import { authRoutes } from './routes/auth.js'
import { adminRoutes } from './routes/admin.js'
import { desktopRoutes } from './routes/desktop.js'
import { dshRoutes } from './routes/dsh.js'
import { pluginRoutes } from './routes/plugins.js'
import { sharedConfigRoutes } from './routes/shared-config.js'

declare module 'fastify' {
  interface FastifyInstance {
    db: Database
    config: ServerConfig
    supervisor: Supervisor
  }
  interface FastifyRequest {
    user: PublicUser | null
  }
}

const webRoot = join(dirname(fileURLToPath(import.meta.url)), '../../web')

/**
 * 构建一个完成全部接线的 Fastify 实例。不调用 `listen`；
 * 绑定与关停由调用方负责。
 * @param config - 解析后的运行时配置。
 */
export async function buildServer(config: ServerConfig): Promise<FastifyInstance> {
  const db = openDatabase(config.dbPath)
  const supervisor = new Supervisor(config)

  const app = Fastify({
    logger: { level: config.logLevel },
    // 仅当部署明确位于自己控制的代理之后时才信任 X-Forwarded-*
    // （否则 request.ip / 限流键可被伪造）。
    trustProxy: config.trustProxy,
    bodyLimit: config.maxUploadBytes,
  })

  app.decorate('db', db)
  app.decorate('config', config)
  app.decorate('supervisor', supervisor)
  app.decorateRequest('user', null)

  app.addHook('onClose', async () => {
    supervisor.teardown()
    db.close()
  })

  // 限流最先注册，让认证/管理面默认得到保护。
  await app.register(rateLimit)

  // 路由组（API）。
  await app.register(authRoutes)
  await app.register(adminRoutes)
  await app.register(desktopRoutes)
  await app.register(dshRoutes)
  await app.register(pluginRoutes)
  await app.register(sharedConfigRoutes)

  // 静态占位 SPA 最后注册，让精确的 API 路由优先于
  // 通配的静态处理器。
  await app.register(fastifyStatic, {
    root: webRoot,
    prefix: '/',
    wildcard: true,
    index: ['index.html'],
  })

  return app
}
