/**
 * Fastify 引导：组装 HTTP 服务器、注册插件与路由，
 * 并通过 close 钩子持有数据库生命周期。
 * @module dsh-admin/web/server
 */

import Fastify, { type FastifyInstance } from 'fastify'
import fastifyStatic from '@fastify/static'
import fastifyMultipart from '@fastify/multipart'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import type { ServerConfig } from '../config.js'
import { openDatabase, type Database } from '../db/connection.js'
import { type PublicUser, purgeExpiredSessions } from '../db/repo.js'
import { Supervisor } from '../supervisor/orchestrator.js'
import { rateLimit } from './middleware/rate-limit.js'
import { authRoutes } from './routes/auth.js'
import { adminRoutes } from './routes/admin.js'
import { fsRoutes } from './routes/fs.js'
import { dshRoutes } from './routes/dsh.js'
import { pluginRoutes } from './routes/plugins.js'
import { sharedConfigRoutes } from './routes/shared-config.js'
import { opsRoutes } from './routes/ops.js'
import { marketRoutes } from './routes/market.js'

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

  // 空 JSON 体（无 body 却带 application/json 的 POST，如前端的
  // /api/dsh/stop）按 {} 处理，而非抛 FST_ERR_CTP_EMPTY_JSON_BODY。
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    if (body === '' || body === undefined) {
      done(null, {})
      return
    }
    try {
      done(null, JSON.parse(body as string))
    } catch (err) {
      ;(err as Error & { statusCode?: number }).statusCode = 400
      done(err as Error, undefined)
    }
  })

  app.decorate('db', db)
  app.decorate('config', config)
  app.decorate('supervisor', supervisor)
  app.decorateRequest('user', null)

  // 过期会话清扫。历史版本搭在登录上（低频、够用）；现在会话表
  // 承载设备管理功能，无人登录的部署也不能让死行无限滞留。
  const sessionSweeper = setInterval(() => purgeExpiredSessions(db), 60 * 60 * 1000)
  sessionSweeper.unref()

  app.addHook('onClose', async () => {
    clearInterval(sessionSweeper)
    supervisor.teardown()
    db.close()
  })

  // 限流最先注册，让认证/管理面默认得到保护。
  await app.register(rateLimit)

  // multipart 流式上传（文件管理器）。preservePath 保留文件夹上传时
  // filename 携带的相对路径（逐段净化见 routes/fs.ts）；单文件上限由
  // limits.fileSize 强制（流式解析不受 JSON bodyLimit 约束）。
  await app.register(fastifyMultipart, {
    preservePath: true,
    limits: {
      fileSize: config.maxFileBytes,
      files: 2000,
      fields: 10,
      fieldNameSize: 64,
      fieldSize: 1024,
    },
  })

  // 路由组（API）。
  await app.register(authRoutes)
  await app.register(adminRoutes)
  await app.register(fsRoutes)
  await app.register(dshRoutes)
  await app.register(pluginRoutes)
  await app.register(sharedConfigRoutes)
  await app.register(opsRoutes)
  await app.register(marketRoutes)

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
