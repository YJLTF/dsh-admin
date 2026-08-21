/**
 * 共享配置路由：管理员维护一套全局 DSH 模型提供商（+ 共享 API key）；
 * 用户看到一条要约，接受后它被合并进用户自己的隔离 DSH 主目录
 * （见 fs/shared-settings）。
 *
 * 凭据值会返回给管理员（他们撰写的），但绝不返回给用户 ——
 * 用户端点只暴露提供商名称和凭据 *引用*。
 * @module dsh-admin/web/routes/shared-config
 */

import type { FastifyPluginAsync } from 'fastify'
import { requireAdmin, requireAuth } from '../middleware/authn.js'
import {
  audit,
  countSharedConfigAcceptances,
  getSharedConfig,
  getSharedConfigState,
  setSharedConfig,
  setSharedConfigState,
} from '../../db/repo.js'
import {
  applySharedConfig,
  parseSharedConfigPayload,
  validateSharedConfigKeys,
  type SharedConfigPayload,
} from '../../fs/shared-settings.js'
import { userHomeDir } from '../../fs/workspace.js'

/** 来自 DSH 提供商指南的输入模态列表 —— 只有 text/image 两种。 */
const inputList = { type: 'array', items: { enum: ['text', 'image'] }, uniqueItems: true } as const

const putSchema = {
  body: {
    type: 'object',
    required: ['payload'],
    additionalProperties: false,
    properties: {
      payload: {
        type: 'object',
        required: ['providers', 'credentials'],
        additionalProperties: false,
        properties: {
          providers: {
            type: 'object',
            additionalProperties: {
              type: 'object',
              properties: {
                displayName: { type: 'string', minLength: 1 },
                baseURL: { type: 'string', minLength: 1 },
                api: { type: 'string', minLength: 1 },
                apiKeyEnv: { type: 'string', minLength: 1 },
                models: {
                  type: 'array',
                  items: {
                    type: 'object',
                    required: ['id'],
                    properties: {
                      id: { type: 'string', minLength: 1 },
                      input: inputList,
                    },
                  },
                },
                // 目录未描述的模型的 route 级回退。
                defaultInput: { ...inputList, minItems: 1 },
                // 目录提供商的覆盖项，以模型 id 为键。
                modelOverrides: {
                  type: 'object',
                  additionalProperties: {
                    type: 'object',
                    additionalProperties: false,
                    properties: { input: inputList },
                  },
                },
                headers: { type: 'object', additionalProperties: { type: 'string' } },
              },
            },
          },
          credentials: { type: 'object', additionalProperties: { type: 'string', minLength: 1 } },
        },
      },
    },
  },
} as const

/** payload 是否提供了任何内容（空要约会隐藏横幅）。 */
function isAvailable(payload: SharedConfigPayload): boolean {
  return Object.keys(payload.providers).length > 0 || Object.keys(payload.credentials).length > 0
}

export const sharedConfigRoutes: FastifyPluginAsync = async (app) => {
  app.get('/api/admin/shared-config', { preHandler: requireAdmin }, async () => {
    const row = getSharedConfig(app.db)
    return {
      payload: row ? parseSharedConfigPayload(row.payload) : { providers: {}, credentials: {} },
      version: row?.version ?? 0,
      updatedAt: row?.updatedAt ?? null,
      acceptances: countSharedConfigAcceptances(app.db),
    }
  })

  app.put('/api/admin/shared-config', { preHandler: requireAdmin, schema: putSchema }, async (request, reply) => {
    const payload = (request.body as { payload: SharedConfigPayload }).payload
    const keyError = validateSharedConfigKeys(payload)
    if (keyError !== null) return reply.code(400).send({ error: 'invalid_key', detail: keyError })
    const row = setSharedConfig(app.db, JSON.stringify(payload))
    audit(app.db, request.user?.id ?? null, 'shared_config_set', JSON.stringify({ version: row.version }))
    return { version: row.version, updatedAt: row.updatedAt }
  })

  app.get('/api/me/shared-config', { preHandler: requireAuth }, async (request) => {
    const row = getSharedConfig(app.db)
    const payload = row ? parseSharedConfigPayload(row.payload) : { providers: {}, credentials: {} }
    const state = getSharedConfigState(app.db, request.user!.id)
    return {
      available: isAvailable(payload),
      version: row?.version ?? 0,
      providers: Object.entries(payload.providers).map(([route, profile]) => ({
        route,
        displayName: typeof profile.displayName === 'string' ? profile.displayName : route,
      })),
      credentialRefs: Object.keys(payload.credentials),
      acceptedVersion: state?.acceptedVersion ?? null,
      updateAvailable: row !== undefined && state?.acceptedVersion !== row.version,
    }
  })

  app.post('/api/me/shared-config/accept', { preHandler: requireAuth }, async (request, reply) => {
    const row = getSharedConfig(app.db)
    if (row === undefined) return reply.code(409).send({ error: 'no_shared_config' })
    // 此处以会话用户为准 —— 无需重读该行记录。
    const userId = request.user!.id
    const payload = parseSharedConfigPayload(row.payload)
    const previousState = getSharedConfigState(app.db, userId)
    const previous =
      previousState === undefined ? null : parseSharedConfigPayload(previousState.appliedPayload)
    try {
      await applySharedConfig(userHomeDir(app.config, userId), payload, previous)
    } catch (error) {
      request.log.error(error, '共享配置应用失败')
      return reply.code(500).send({ error: 'apply_failed' })
    }
    setSharedConfigState(app.db, userId, row.version, row.payload)
    audit(app.db, userId, 'shared_config_accept', JSON.stringify({ version: row.version }))
    return { ok: true, version: row.version }
  })
}
