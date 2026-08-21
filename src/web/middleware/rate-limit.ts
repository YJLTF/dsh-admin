/**
 * 全局限流。认证/管理面在 P1 中会获得各自更严格的上限；
 * 此基线覆盖整个服务器。
 * @module dsh-admin/web/middleware/rate-limit
 */

import type { FastifyPluginAsync } from 'fastify'
import fastifyRateLimit from '@fastify/rate-limit'

/** 注册基线限流器（作用于所有路由）。 */
export const rateLimit: FastifyPluginAsync = async (app) => {
  await app.register(fastifyRateLimit, {
    max: 100,
    timeWindow: '1 minute',
    global: true,
  })
}
