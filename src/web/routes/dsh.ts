/**
 * DSH 拉起 / 监管 / 重启路由。Launch 解析所请求的文件夹、读取其已启用
 * 插件、写入 cordis patch 并拉起主 + 看门狗进程对；restart 写入重启后
 * 命令交接文件并重新拉起主实例。
 * @module dsh-admin/web/routes/dsh
 */

import type { FastifyPluginAsync } from 'fastify'
import { mkdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { requireAuth } from '../middleware/authn.js'
import { resolveUserPath } from '../middleware/fs-guard.js'
import { findWorkspaceByPath, getEnabledPluginIds } from '../../db/repo.js'
import { listInstalledPlugins } from '../../fs/plugins.js'
import { AlreadyRunningError } from '../../supervisor/orchestrator.js'
import { renderPatch } from '../../supervisor/patch.js'

const launchSchema = {
  body: {
    type: 'object',
    required: ['folder'],
    additionalProperties: false,
    properties: { folder: { type: 'string', maxLength: 512 } },
  },
} as const

const restartSchema = {
  body: {
    type: 'object',
    required: ['command'],
    additionalProperties: false,
    properties: { command: { type: 'string', maxLength: 1024 } },
  },
} as const

function alive(status: string | undefined): boolean {
  return status !== undefined && status !== 'crashed' && status !== 'stopped'
}

/** 用户打开以访问运行中子 DSH 的 URL，不可达时为 ''。 */
function dshUrl(config: { host: string; publicHost: string }, port: number | undefined): string {
  // 内网模式：服务器通过已发布的主机名/IP 访问，因此直接链接子 DSH
  // 自己的已发布端口（每主实例的转发器把容器的 eth0 桥接到子进程的
  // 环回监听）。
  if (config.publicHost !== '' && port !== undefined) return `http://${config.publicHost}:${port}/`
  // 绑定环回的开发服务器：子进程自己的环回端口在同一台机器上可达
  // （无需转发器；页面源就是环回）。
  const loopback = config.host === '127.0.0.1' || config.host === 'localhost' || config.host === '::1'
  if (loopback && port !== undefined) return `http://127.0.0.1:${port}/`
  return ''
}

export const dshRoutes: FastifyPluginAsync = async (app) => {
  app.post('/api/dsh/launch', { preHandler: requireAuth, schema: launchSchema }, async (request, reply) => {
    const { folder } = request.body as { folder: string }
    const user = request.user!
    const p = resolveUserPath(app.config, user.id, folder)
    if (!p.ok) return reply.code(400).send({ error: 'bad_path' })
    try {
      if (!(await stat(p.abs)).isDirectory()) return reply.code(400).send({ error: 'not_a_folder' })
    } catch {
      return reply.code(404).send({ error: 'not_found' })
    }

    // 每文件夹插件选择 → cordis patch。仅当 dsh CLI 支持
    // --patch（enablePatch）时写入；否则子进程不带它、干净启动。
    let patchPath: string | undefined
    if (app.config.enablePatch) {
      const workspace = findWorkspaceByPath(app.db, user.id, folder)
      // 只注入用户仍然安装着的插件；否则对已卸载 bundle 的过期残留
      // 选择会在子 DSH 里解析失败。
      const installed = new Set((await listInstalledPlugins(app.config, user.id)).map((plugin) => plugin.id))
      const enabled = (workspace === undefined ? [] : getEnabledPluginIds(app.db, workspace.id))
        .filter((id) => installed.has(id))
      const patchesDir = join(app.config.dataRoot, 'users', user.id, 'patches')
      await mkdir(patchesDir, { recursive: true })
      patchPath = join(patchesDir, `${workspace?.id ?? 'default'}.yml`)
      await writeFile(patchPath, renderPatch(enabled))
    }

    try {
      const instance = await app.supervisor.launch(user.id, p.abs, patchPath)
      return {
        instance: { id: instance.id, port: instance.port, status: instance.status },
        url: dshUrl(app.config, instance.port),
      }
    } catch (err) {
      if (err instanceof AlreadyRunningError) return reply.code(409).send({ error: 'already_running' })
      throw err
    }
  })

  app.post('/api/dsh/restart', { preHandler: requireAuth, schema: restartSchema }, async (request, reply) => {
    const { command } = request.body as { command: string }
    const user = request.user!
    // 注意：必须与 Supervisor 私有的 handoffPath() 一致 —— `users/<id>/handoff.json`
    // （刻意不放在 `home/` 内，修复时那里可能被清空）。
    const handoffPath = join(app.config.dataRoot, 'users', user.id, 'handoff.json')
    await mkdir(join(app.config.dataRoot, 'users', user.id), { recursive: true })
    await writeFile(handoffPath, JSON.stringify({ command, createdAt: Date.now() }))
    const instance = await app.supervisor.restartMain(user.id)
    if (instance === undefined) return reply.code(404).send({ error: 'not_running' })
    await app.supervisor.spawnWatchdog(user.id)
    return {
      instance: { id: instance.id, port: instance.port, status: instance.status },
      url: dshUrl(app.config, instance.port),
    }
  })

  app.post('/api/dsh/stop', { preHandler: requireAuth }, async (request) => {
    app.supervisor.stop(request.user!.id)
    return { ok: true }
  })

  app.get('/api/dsh/status', { preHandler: requireAuth }, async (request) => {
    const { main, watchdog } = app.supervisor.status(request.user!.id)
    return {
      running: alive(main?.status),
      instance: main
        ? { id: main.id, port: main.port, status: main.status, exitCode: main.exitCode, lastError: main.lastError }
        : null,
      watchdog: watchdog ? { id: watchdog.id, status: watchdog.status, exitCode: watchdog.exitCode } : null,
      url: dshUrl(app.config, main?.port),
    }
  })
}
