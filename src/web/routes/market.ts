/**
 * 插件市场路由。管理侧：导入 tgz（解包 + 判型 + 静态检查）、列表、
 * 删除；用户侧：浏览可装条目、安装/卸载到自己的 DSH home。
 * 域逻辑见 src/fs/market.ts；重启生效闭环复用 /api/dsh/restart。
 * @module dsh-admin/web/routes/market
 */

import type { FastifyPluginAsync } from 'fastify'
import { createWriteStream } from 'node:fs'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, rm } from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'
import { join } from 'node:path'
import { requireAdmin, requireAuth } from '../middleware/authn.js'
import {
  audit,
  deleteMarketItemRow,
  countMarketInstalls,
  findMarketItemById,
  findMarketItemByKnv,
  findUserPluginByName,
  insertMarketItem,
  latestMarketItemByName,
  listMarketItems,
  listUserPlugins,
  removeUserPlugin,
  updateMarketItem,
  upsertUserPlugin,
} from '../../db/repo.js'
import {
  detectMarketKind,
  extractTgz,
  installMarketItem,
  readMarketMeta,
  uninstallMarketItem,
  type MarketKind,
} from '../../fs/market.js'
import { listInstalledPlugins } from '../../fs/plugins.js'

/** warnings 列是 JSON 字符串；展示层拿到数组。 */
function parseWarnings(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((w): w is string => typeof w === 'string') : []
  } catch {
    return []
  }
}

function toItemView(row: import('../../db/repo.js').MarketItemRow, db: import('../../db/connection.js').Database) {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    version: row.version,
    description: row.description,
    warnings: parseWarnings(row.warnings),
    importedAt: row.importedAt,
    installs: countMarketInstalls(db, row.id),
  }
}

export const marketRoutes: FastifyPluginAsync = async (app) => {
  const config = app.config
  const marketRoot = join(config.dataRoot, 'market')

  app.get('/api/admin/market', { preHandler: requireAdmin }, async () => ({
    items: listMarketItems(app.db).map((row) => toItemView(row, app.db)),
  }))

  /**
   * 导入 tgz（如 GitHub codeload 归档）。同 kind+name+version 重复
   * 导入 = 覆盖更新（指向新目录）。script 型与无特征仓库拒绝。
   */
  app.post('/api/admin/market/import', { preHandler: requireAdmin }, async (request, reply) => {
    if (!request.isMultipart()) return reply.code(400).send({ error: 'expected_multipart' })
    await mkdir(marketRoot, { recursive: true })
    const tmpTgz = join(marketRoot, `..import-${randomBytes(6).toString('hex')}.tgz`)
    const itemDir = join(marketRoot, randomUUID())
    try {
      let sawFile = false
      for await (const part of request.parts()) {
        if (part.type !== 'file') continue
        sawFile = true
        await pipeline(part.file, createWriteStream(tmpTgz))
        if (part.file.truncated) return reply.code(413).send({ error: 'too_large' })
        break // 只取第一个文件 part
      }
      if (!sawFile) return reply.code(400).send({ error: 'missing_file' })

      const srcDir = await extractTgz(tmpTgz, itemDir)
      const kind = await detectMarketKind(srcDir)
      if (kind === 'script') {
        return reply.code(422).send({ error: 'script_kind_unsupported', message: 'install 脚本型插件不被支持（本平台不执行第三方脚本）' })
      }
      if (kind === 'none') {
        return reply.code(422).send({ error: 'no_market_signature', message: '未发现任何 DSH 插件特征（dsh 字段 / SKILL.md / preset 组合）' })
      }
      const meta = await readMarketMeta(srcDir, kind as MarketKind)
      const warnings = JSON.stringify(meta.warnings)

      const existing = findMarketItemByKnv(app.db, meta.kind, meta.name, meta.version)
      if (existing !== undefined) {
        // 覆盖更新：换目录、刷元数据；旧目录清理放 DB 更新之后
        // （先删文件后更行失败会让行指向已删目录）。
        updateMarketItem(app.db, existing.id, { description: meta.description, dir: srcDir, warnings })
        await rm(existing.dir, { recursive: true, force: true }).catch(() => {})
        audit(app.db, request.user?.id ?? null, 'market_import', JSON.stringify({ name: meta.name, version: meta.version, overwrite: true }))
        return { item: { ...toItemView(findMarketItemById(app.db, existing.id)!, app.db) } }
      }
      const id = randomUUID()
      insertMarketItem(app.db, { id, kind: meta.kind, name: meta.name, version: meta.version, description: meta.description, dir: srcDir, warnings })
      audit(app.db, request.user?.id ?? null, 'market_import', JSON.stringify({ name: meta.name, version: meta.version }))
      return { item: toItemView(findMarketItemById(app.db, id)!, app.db) }
    } catch (err) {
      // 判型/元数据失败 → 422 语义错误；其余按 500 冒泡。
      await rm(itemDir, { recursive: true, force: true }).catch(() => {})
      if (err instanceof Error && /非法的包名|无法确定/.test(err.message)) {
        return reply.code(422).send({ error: 'invalid_metadata', message: err.message })
      }
      throw err
    } finally {
      await rm(tmpTgz, { force: true }).catch(() => {})
    }
  })

  /** 删除市场条目。已安装用户的 home 里的文件不动（他们可另行卸载），
   * user_plugins 记录经外键级联消失。 */
  app.delete('/api/admin/market/:id', { preHandler: requireAdmin }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const item = findMarketItemById(app.db, id)
    if (item === undefined) return reply.code(404).send({ error: 'not_found' })
    deleteMarketItemRow(app.db, id)
    await rm(item.dir, { recursive: true, force: true }).catch(() => {})
    audit(app.db, request.user?.id ?? null, 'market_delete', JSON.stringify({ name: item.name, version: item.version }))
    return { ok: true }
  })

  /** 用户侧市场列表 + 已装记录（含可更新标记）。 */
  app.get('/api/me/market', { preHandler: requireAuth }, async (request) => {
    const userId = request.user!.id
    const items = listMarketItems(app.db).map((row) => toItemView(row, app.db))
    const installed = listUserPlugins(app.db, userId).map((row) => {
      const latest = latestMarketItemByName(app.db, row.kind, row.name)
      return {
        ...row,
        updateAvailable: latest !== undefined && latest.version !== row.version,
        latestVersion: latest?.version ?? row.version,
      }
    })
    return { items, installed }
  })

  app.post('/api/me/market/:id/install', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const item = findMarketItemById(app.db, id)
    if (item === undefined) return reply.code(404).send({ error: 'not_found' })
    const userId = request.user!.id
    if (item.kind === 'cordis-plugin') {
      // 已在 profile bundles 里的同名包会经双通道加载（§6.4 双注册
      // 崩溃），拒绝安装。
      const bundles = await listInstalledPlugins(config, userId)
      if (bundles.some((plugin) => plugin.id === item.name)) {
        return reply.code(409).send({ error: 'conflicts_with_profile_bundle' })
      }
    }
    await installMarketItem(config, userId, { kind: item.kind, name: item.name, dir: item.dir })
    upsertUserPlugin(app.db, userId, { marketItemId: item.id, kind: item.kind, name: item.name, version: item.version })
    audit(app.db, userId, 'plugin_install', JSON.stringify({ name: item.name, version: item.version }))
    return {
      ok: true,
      // 运行中的实例要重启才加载新装/卸载的插件。
      restartRecommended: app.supervisor.status(userId).main?.status === 'running',
    }
  })

  const uninstallSchema = {
    body: {
      type: 'object',
      required: ['name'],
      additionalProperties: false,
      properties: { name: { type: 'string', minLength: 1, maxLength: 214 } },
    },
  } as const

  app.post('/api/me/market/uninstall', { preHandler: requireAuth, schema: uninstallSchema }, async (request, reply) => {
    const { name } = request.body as { name: string }
    const userId = request.user!.id
    const row = findUserPluginByName(app.db, userId, name)
    if (row === undefined) return reply.code(404).send({ error: 'not_installed' })
    await uninstallMarketItem(config, userId, row.kind, row.name)
    removeUserPlugin(app.db, userId, name)
    audit(app.db, userId, 'plugin_uninstall', JSON.stringify({ name }))
    return {
      ok: true,
      restartRecommended: app.supervisor.status(userId).main?.status === 'running',
    }
  })
}
