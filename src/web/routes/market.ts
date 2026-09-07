/**
 * 插件市场路由。管理侧：导入 tgz（解包 + 多根扫描 + 静态检查 +
 * 披露解析 + cordis 插件沙箱启动探测）、列表、删除、手动重校验；
 * 用户侧：浏览可装条目、安装/卸载到自己的 DSH home。
 * 域逻辑见 src/fs/market.ts；dsh ≥0.1.2-rc.1 的 web profile 默认
 * `patchReload: "live"`，cordis 插件装/卸写 profile 级
 * `cordis.patch.yml` 即被运行中实例热重载，响应里的 `reload: 'hot'`
 * 表达这一语义（旧版 dsh 回退为 `reload: 'restart'`）。
 * @module dsh-admin/web/routes/market
 */

import type { FastifyPluginAsync } from 'fastify'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { requireAdmin, requireAuth } from '../middleware/authn.js'
import { saveSelectedFileParts } from '../multipart.js'
import {
  audit,
  countMarketInstallsAll,
  deleteMarketItemRow,
  demoteUserPluginsToUser,
  findMarketItemById,
  findMarketItemByKnv,
  findUserPluginByName,
  insertMarketItem,
  listLatestItemVersions,
  listMarketItems,
  listPublicUsers,
  listSharedMarketItems,
  listUserPlugins,
  removeUserPlugin,
  setMarketItemShared,
  setSetting,
  updateMarketItem,
  updateMarketItemValidation,
  upsertUserPlugin,
} from '../../db/repo.js'
import {
  copyTree,
  parsePackMeta,
  readMarketDisclosure,
  scanMarketRoots,
  supportsLivePatchReload,
  validateHomePatch,
  validatePluginConfig,
  extractTgz,
  installMarketItem,
  readMarketMeta,
  uninstallMarketItem,
  type MarketKind,
  type MarketValidation,
} from '../../fs/market.js'
import {
  getSharedPatch,
  normalizeSharedPatch,
  removeSharedPatch,
  SHARED_PATCH_KEY,
  syncSharedItemsForUser,
  writeSharedPatch,
} from '../../fs/shared-sync.js'
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

function parseJsonColumn<T>(raw: string, fallback: T): T {
  if (raw === '') return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

/** 管理台条目视图：installs 由列表页一次聚合传入（非逐行 COUNT）。 */
function toAdminItemView(
  row: import('../../db/repo.js').MarketItemRow,
  installs: number,
) {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    version: row.version,
    description: row.description,
    warnings: parseWarnings(row.warnings),
    validation: parseJsonColumn<MarketValidation | null>(row.validation, null),
    disclosure: parseJsonColumn<import('../../fs/market.js').MarketDisclosure | null>(row.disclosure, null),
    packMeta: parseJsonColumn<import('../../fs/market.js').PackMeta | null>(row.packMeta, null),
    shared: row.shared,
    importedAt: row.importedAt,
    installs,
  }
}

/** 用户侧条目视图：不含 installs（管理信息，无需暴露）。 */
function toUserItemView(row: import('../../db/repo.js').MarketItemRow) {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    version: row.version,
    description: row.description,
    warnings: parseWarnings(row.warnings),
    validation: parseJsonColumn<MarketValidation | null>(row.validation, null),
    disclosure: parseJsonColumn<import('../../fs/market.js').MarketDisclosure | null>(row.disclosure, null),
    packMeta: parseJsonColumn<import('../../fs/market.js').PackMeta | null>(row.packMeta, null),
    shared: row.shared,
    importedAt: row.importedAt,
  }
}

export const marketRoutes: FastifyPluginAsync = async (app) => {
  const config = app.config
  const marketRoot = join(config.dataRoot, 'market')

  app.get('/api/admin/market', { preHandler: requireAdmin }, async () => {
    const installs = countMarketInstallsAll(app.db)
    return { items: listMarketItems(app.db).map((row) => toAdminItemView(row, installs.get(row.id) ?? 0)) }
  })

  /**
   * 导入 tgz（如 GitHub codeload 归档）。同 kind+name+version 重复
   * 导入 = 覆盖更新（指向新目录）。根目录未命中特征时按 STANDARD §1
   * 扫描子目录（多包仓库/技能合集 → 一次导入产生多条目，各自拥有
   * 独立存储目录）。script 型与完全无特征拒绝。可选第二个文件 part
   * `meta`：offline-packager 的 *.meta.json（打包元数据）。
   */
  app.post('/api/admin/market/import', { preHandler: requireAdmin }, async (request, reply) => {
    if (!request.isMultipart()) return reply.code(400).send({ error: 'expected_multipart' })
    await mkdir(marketRoot, { recursive: true })
    const tmpTgz = join(marketRoot, `..import-${randomBytes(6).toString('hex')}.tgz`)
    const tmpMeta = `${tmpTgz}.meta`
    const itemDir = join(marketRoot, randomUUID())
    try {
      // 第一个文件 part 是插件包；可选的 `meta` part 是 offline-packager
      // 的 *.meta.json；其余文件 part 忽略。
      let sawFile = false
      let sawMeta = false
      const saved = await saveSelectedFileParts(request, (fieldname, fileIndex) => {
        if (fileIndex === 0) {
          sawFile = true
          return tmpTgz
        }
        if (fieldname === 'meta' && !sawMeta) {
          sawMeta = true
          return tmpMeta
        }
        return null
      })
      if (saved === 'too_large') return reply.code(413).send({ error: 'too_large' })
      if (!sawFile) return reply.code(400).send({ error: 'missing_file' })

      const srcDir = await extractTgz(tmpTgz, itemDir)
      const scan = await scanMarketRoots(srcDir)
      if (scan.rootKind === 'script') {
        return reply.code(422).send({ error: 'script_kind_unsupported', message: 'install 脚本型插件不被支持（本平台不执行第三方脚本）' })
      }
      if (scan.roots.length === 0) {
        return reply.code(422).send({ error: 'no_market_signature', message: '未发现任何 DSH 插件特征（dsh 字段 / SKILL.md / preset 组合）' })
      }

      // offline-packager 元数据（可选）
      const uploadedMeta = sawMeta ? parsePackMeta(await readFile(tmpMeta, 'utf8')) : null

      const rows: import('../../db/repo.js').MarketItemRow[] = []
      const skipped: Array<{ name: string; error: string }> = []
      const createdDirs: string[] = []
      try {
        for (const root of scan.roots) {
          let meta
          try {
            meta = await readMarketMeta(root.dir, root.kind)
          } catch (err) {
            skipped.push({ name: root.dir.split(/[\\/]/).pop() ?? root.dir, error: err instanceof Error ? err.message : String(err) })
            continue
          }
          // 每个条目独立存储目录：删除单条目时直接 rm 自己的目录，
          // 不会波及同次导入的其他条目。
          const storeDir = join(marketRoot, randomUUID())
          await copyTree(root.dir, storeDir)
          createdDirs.push(storeDir)

          const disclosure = await readMarketDisclosure(root.dir, root.kind)
          const packMeta =
            root.kind === 'cordis-plugin'
              ? { ...(meta.selfContained ? { selfContained: true } : {}), ...(uploadedMeta ?? {}) }
              : null
          const validation =
            root.kind === 'cordis-plugin' ? await validatePluginConfig(config, storeDir, meta.name) : null

          const existing = findMarketItemByKnv(app.db, meta.kind, meta.name, meta.version)
          const fields = {
            description: meta.description,
            dir: storeDir,
            warnings: JSON.stringify(meta.warnings),
            validation: validation === null ? undefined : JSON.stringify(validation),
            disclosure: JSON.stringify(disclosure),
            packMeta: packMeta === null ? undefined : JSON.stringify(packMeta),
          }
          if (existing !== undefined) {
            // 覆盖更新：换目录、刷元数据；旧目录清理放 DB 更新之后
            // （先删文件后更行失败会让行指向已删目录）。
            updateMarketItem(app.db, existing.id, fields)
            await rm(existing.dir, { recursive: true, force: true }).catch(() => {})
            rows.push(findMarketItemById(app.db, existing.id)!)
          } else {
            const id = randomUUID()
            insertMarketItem(app.db, { id, kind: meta.kind, name: meta.name, version: meta.version, ...fields })
            rows.push(findMarketItemById(app.db, id)!)
          }
          audit(app.db, request.user?.id ?? null, 'market_import', JSON.stringify({
            name: meta.name,
            version: meta.version,
            overwrite: existing !== undefined,
          }))
        }
      } catch (err) {
        // 任何未预期失败：清掉本次新建的存储目录（数据库未动的部分）。
        for (const dir of createdDirs) await rm(dir, { recursive: true, force: true }).catch(() => {})
        throw err
      }

      if (rows.length === 0) {
        const detail = skipped.map((s) => `${s.name}: ${s.error}`).join('；')
        return reply.code(422).send({ error: 'invalid_metadata', message: detail })
      }
      const installs = countMarketInstallsAll(app.db)
      return { items: rows.map((row) => toAdminItemView(row, installs.get(row.id) ?? 0)), skipped }
    } catch (err) {
      // 判型/元数据失败 → 422 语义错误；其余按 500 冒泡。
      await rm(itemDir, { recursive: true, force: true }).catch(() => {})
      if (err instanceof Error && /非法的包名|无法确定/.test(err.message)) {
        return reply.code(422).send({ error: 'invalid_metadata', message: err.message })
      }
      throw err
    } finally {
      await rm(tmpTgz, { force: true }).catch(() => {})
      await rm(tmpMeta, { force: true }).catch(() => {})
    }
  })

  /** 手动重跑 cordis 插件的沙箱启动探测（dsh CLI 更新后结论可能翻转）。 */
  app.post('/api/admin/market/:id/validate', { preHandler: requireAdmin }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const item = findMarketItemById(app.db, id)
    if (item === undefined) return reply.code(404).send({ error: 'not_found' })
    if (item.kind !== 'cordis-plugin') {
      return reply.code(422).send({ error: 'validation_not_applicable', message: '仅 cordis 插件需要组合配置校验' })
    }
    const validation = await validatePluginConfig(config, item.dir, item.name)
    updateMarketItemValidation(app.db, id, JSON.stringify(validation))
    audit(app.db, request.user?.id ?? null, 'market_validate', JSON.stringify({
      name: item.name,
      version: item.version,
      status: validation.status,
    }))
    return { validation }
  })

  /** 推送全员开关（仅技能/预设）：打开后立即同步给所有可用用户，
   * 之后每次 launch 前自动补齐/升级；关闭则安装记录降级为用户自装
   * （已装文件保留，用户可自行卸载）。 */
  const sharedSchema = {
    body: {
      type: 'object',
      required: ['shared'],
      additionalProperties: false,
      properties: { shared: { type: 'boolean' } },
    },
  } as const

  app.post('/api/admin/market/:id/shared', { preHandler: requireAdmin, schema: sharedSchema }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const { shared } = request.body as { shared: boolean }
    const item = findMarketItemById(app.db, id)
    if (item === undefined) return reply.code(404).send({ error: 'not_found' })
    if (item.kind === 'cordis-plugin') {
      return reply.code(422).send({
        error: 'shared_kind_unsupported',
        message: '共享推送仅支持技能与 agent 预设（cordis 插件请让用户自行从市场安装，避免双通道注册）',
      })
    }
    setMarketItemShared(app.db, id, shared)
    let synced = 0
    if (shared) {
      for (const user of listPublicUsers(app.db)) {
        if (user.role !== 'active' && user.role !== 'admin') continue
        synced += await syncSharedItemsForUser(config, app.db, user.id).catch(() => 0)
      }
    } else {
      demoteUserPluginsToUser(app.db, id)
    }
    audit(app.db, request.user?.id ?? null, 'market_shared', JSON.stringify({ name: item.name, version: item.version, shared, synced }))
    return { ok: true, synced }
  })

  // ---------- 管理员共享 patch 层（home 级 cordis.patch.yml）----------

  app.get('/api/admin/shared-patch', { preHandler: requireAdmin }, async () => {
    const patch = getSharedPatch(app.db)
    return { yaml: patch?.yaml ?? '', updatedAt: patch?.updatedAt ?? null }
  })

  /** 保存共享 patch：形状校验 → 沙箱启动校验（坏 patch 会打挂全员
   * DSH 启动，必须挡在保存前）→ 全员同步。清空 = 删除各用户的文件。 */
  const sharedPatchSchema = {
    body: {
      type: 'object',
      required: ['yaml'],
      additionalProperties: false,
      properties: { yaml: { type: 'string', maxLength: 65536 } },
    },
  } as const

  app.put('/api/admin/shared-patch', { preHandler: requireAdmin, schema: sharedPatchSchema }, async (request, reply) => {
    const { yaml } = request.body as { yaml: string }
    const normalized = normalizeSharedPatch(yaml)
    if (!normalized.ok) {
      return reply.code(422).send({ error: 'invalid_shared_patch', message: normalized.error })
    }
    const validation = await validateHomePatch(config, normalized.yaml)
    if (validation.status === 'fail') {
      return reply.code(422).send({ error: 'patch_boot_failed', message: validation.detail ?? '带该共享 patch 时 dsh web 启动失败' })
    }
    setSetting(app.db, SHARED_PATCH_KEY, normalized.yaml)
    let synced = 0
    for (const user of listPublicUsers(app.db)) {
      if (user.role !== 'active' && user.role !== 'admin') continue
      try {
        if (normalized.yaml === '') await removeSharedPatch(config, user.id)
        else await writeSharedPatch(config, user.id, normalized.yaml)
        synced++
      } catch {
        // 单用户同步失败（如目录被占用）不回滚保存；下次 launch 会补齐。
      }
    }
    audit(app.db, request.user?.id ?? null, 'shared_patch_save', JSON.stringify({
      bytes: Buffer.byteLength(normalized.yaml),
      cleared: normalized.yaml === '',
      bootValidation: validation.status,
      synced,
    }))
    return { ok: true, synced, bootValidation: validation.status, bootDetail: validation.detail ?? null }
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

  /** 用户侧市场列表 + 已装记录（含可更新标记）。更新检测用一次聚合
   * 取每个 (kind,name) 的最新版本，替代逐安装行查询。 */
  app.get('/api/me/market', { preHandler: requireAuth }, async (request) => {
    const userId = request.user!.id
    const items = listMarketItems(app.db).map(toUserItemView)
    const latest = listLatestItemVersions(app.db)
    const installed = listUserPlugins(app.db, userId).map((row) => {
      const latestVersion = latest.get(`${row.kind}/${row.name}`)
      return {
        ...row,
        updateAvailable: latestVersion !== undefined && latestVersion !== row.version,
        latestVersion: latestVersion ?? row.version,
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
    // 来源语义：条目是推送的、或用户身上已是 shared 安装 → 保持 shared
    //（防止自装/升级把管理员推送降级成可卸载的自装）。
    const existing = findUserPluginByName(app.db, userId, item.name)
    const source: 'user' | 'shared' = item.shared || existing?.source === 'shared' ? 'shared' : 'user'
    upsertUserPlugin(app.db, userId, { marketItemId: item.id, kind: item.kind, name: item.name, version: item.version, source })
    audit(app.db, userId, 'plugin_install', JSON.stringify({ name: item.name, version: item.version }))
    return {
      ok: true,
      ...(await reloadInfo(item.kind, userId)),
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
    if (row.source === 'shared') {
      return reply.code(409).send({
        error: 'managed_by_shared',
        message: '该条目由管理员推送全员，不能自行卸载（请联系管理员取消推送）',
      })
    }
    await uninstallMarketItem(config, userId, row.kind, row.name)
    removeUserPlugin(app.db, userId, name)
    audit(app.db, userId, 'plugin_uninstall', JSON.stringify({ name }))
    return {
      ok: true,
      ...(await reloadInfo(row.kind, userId)),
    }
  })

  /** 安装/卸载后的生效语义：cordis 插件在 dsh ≥0.1.2-rc.1 上由 live
   * patch 重载即时生效；否则（旧版 dsh 或技能/预设，技能文件由新会话
   * 读取）运行中的实例保守建议重启。 */
  async function reloadInfo(kind: MarketKind, userId: string): Promise<{ reload: 'hot' | 'restart' | 'none'; restartRecommended: boolean }> {
    const running = app.supervisor.status(userId).main?.status === 'running'
    if (!running) return { reload: 'none', restartRecommended: false }
    const hot = kind === 'cordis-plugin' && supportsLivePatchReload(await app.supervisor.dshVersion())
    return { reload: hot ? 'hot' : 'restart', restartRecommended: !hot }
  }
}
