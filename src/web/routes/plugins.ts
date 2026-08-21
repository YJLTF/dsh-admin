/**
 * 插件列表 / 每文件夹选择路由。目录按用户从常驻 DSH profile 发现；
 * 选择持久化到 `folder_plugins`（以文件夹工作区为键），并在拉起时
 * 注入子 DSH。
 * @module dsh-admin/web/routes/plugins
 */

import type { FastifyPluginAsync } from 'fastify'
import { requireAuth } from '../middleware/authn.js'
import { resolveUserPath } from '../middleware/fs-guard.js'
import { listInstalledPlugins } from '../../fs/plugins.js'
import { findWorkspaceByPath, getEnabledPluginIds, getOrCreateWorkspace, setFolderPlugins } from '../../db/repo.js'

const selectSchema = {
  body: {
    type: 'object',
    required: ['folder', 'plugins'],
    additionalProperties: false,
    properties: {
      folder: { type: 'string', maxLength: 512 },
      plugins: {
        type: 'array',
        items: {
          type: 'object',
          required: ['id', 'enabled'],
          additionalProperties: false,
          properties: { id: { type: 'string' }, enabled: { type: 'boolean' } },
        },
      },
    },
  },
} as const

interface Selection {
  id: string
  enabled: boolean
}

export const pluginRoutes: FastifyPluginAsync = async (app) => {
  app.get('/api/plugins', { preHandler: requireAuth }, async (request, reply) => {
    const { folder = '' } = request.query as { folder?: string }
    const p = resolveUserPath(app.config, request.user!.id, folder)
    if (!p.ok) return reply.code(400).send({ error: 'bad_path' })
    const workspace = findWorkspaceByPath(app.db, request.user!.id, folder)
    const enabled = workspace === undefined ? [] : getEnabledPluginIds(app.db, workspace.id)
    const installed = await listInstalledPlugins(app.config, request.user!.id)
    return {
      plugins: installed.map((plugin) => ({ ...plugin, enabled: enabled.includes(plugin.id) })),
    }
  })

  app.post('/api/plugins/select', { preHandler: requireAuth, schema: selectSchema }, async (request, reply) => {
    const { folder, plugins } = request.body as { folder: string; plugins: Selection[] }
    const p = resolveUserPath(app.config, request.user!.id, folder)
    if (!p.ok) return reply.code(400).send({ error: 'bad_path' })
    // 允许列表：只持久化用户确实已安装的 id。
    const catalogIds = new Set((await listInstalledPlugins(app.config, request.user!.id)).map((plugin) => plugin.id))
    const filtered = plugins.filter((plugin) => catalogIds.has(plugin.id))
    const workspace = getOrCreateWorkspace(app.db, request.user!.id, folder)
    setFolderPlugins(app.db, workspace.id, filtered)
    return { ok: true }
  })
}
