/**
 * 桌面 / 文件系统路由：列出用户的工作区、创建文件夹、上传文件。
 * 每个路径都规范到调用者自己的工作区根目录之下，
 * 因此一个用户永远无法寻址另一个用户的文件。
 * @module dsh-admin/web/routes/desktop
 */

import type { FastifyPluginAsync } from 'fastify'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { requireAuth } from '../middleware/authn.js'
import { resolveUserPath, safeFilename } from '../middleware/fs-guard.js'
import { listDir } from '../../fs/workspace.js'

const mkdirSchema = {
  body: {
    type: 'object',
    required: ['path'],
    additionalProperties: false,
    properties: { path: { type: 'string', maxLength: 512 } },
  },
} as const

const uploadSchema = {
  body: {
    type: 'object',
    required: ['path', 'name', 'data'],
    additionalProperties: false,
    properties: {
      path: { type: 'string', maxLength: 512 },
      name: { type: 'string', maxLength: 255 },
      data: { type: 'string' },
    },
  },
} as const

/** 严格的 base64 校验 —— `Buffer.from(x, 'base64')` 从不抛错，它会
 * 静默丢弃非法字符，因此没有这一步，垃圾载荷会被存成截断的文件。 */
function decodeBase64(data: string): Buffer | null {
  const body = data.replaceAll('\n', '').replaceAll('\r', '').replaceAll(' ', '')
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(body)) return null
  return Buffer.from(body, 'base64')
}

export const desktopRoutes: FastifyPluginAsync = async (app) => {
  app.get('/api/desktop/tree', { preHandler: requireAuth }, async (request, reply) => {
    const { path = '' } = request.query as { path?: string }
    const p = resolveUserPath(app.config, request.user!.id, path)
    if (!p.ok) return reply.code(400).send({ error: 'bad_path' })
    try {
      return { path, entries: await listDir(p.abs) }
    } catch {
      return reply.code(404).send({ error: 'not_found' })
    }
  })

  app.post('/api/fs/mkdir', { preHandler: requireAuth, schema: mkdirSchema }, async (request, reply) => {
    const { path } = request.body as { path: string }
    const p = resolveUserPath(app.config, request.user!.id, path)
    if (!p.ok) return reply.code(400).send({ error: 'bad_path' })
    try {
      await mkdir(p.abs)
      return { ok: true }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'EEXIST') return reply.code(409).send({ error: 'exists' })
      if (code === 'ENOENT') return reply.code(404).send({ error: 'parent_missing' })
      throw err
    }
  })

  app.post('/api/fs/upload', { preHandler: requireAuth, schema: uploadSchema }, async (request, reply) => {
    const { path, name, data } = request.body as { path: string; name: string; data: string }
    const p = resolveUserPath(app.config, request.user!.id, path)
    if (!p.ok) return reply.code(400).send({ error: 'bad_path' })
    let filename: string
    try {
      filename = safeFilename(name)
    } catch {
      return reply.code(400).send({ error: 'bad_name' })
    }
    const buf = decodeBase64(data)
    if (buf === null) return reply.code(400).send({ error: 'bad_data' })
    try {
      await writeFile(join(p.abs, filename), buf)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return reply.code(404).send({ error: 'parent_missing' })
      throw err
    }
    return { ok: true, name: filename }
  })

  const createSchema = {
    body: {
      type: 'object',
      required: ['path', 'name', 'type'],
      additionalProperties: false,
      properties: {
        path: { type: 'string', maxLength: 512 },
        name: { type: 'string', maxLength: 255 },
        type: { type: 'string', enum: ['file', 'dir'] },
      },
    },
  } as const

  app.post('/api/fs/create', { preHandler: requireAuth, schema: createSchema }, async (request, reply) => {
    const { path, name, type } = request.body as { path: string; name: string; type: 'file' | 'dir' }
    const p = resolveUserPath(app.config, request.user!.id, path)
    if (!p.ok) return reply.code(400).send({ error: 'bad_path' })
    let filename: string
    try {
      filename = safeFilename(name)
    } catch {
      return reply.code(400).send({ error: 'bad_name' })
    }
    const target = join(p.abs, filename)
    try {
      if (type === 'dir') await mkdir(target)
      else await writeFile(target, '')
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'EEXIST') return reply.code(409).send({ error: 'exists' })
      if (code === 'ENOENT') return reply.code(404).send({ error: 'parent_missing' })
      throw err
    }
    return { ok: true, name: filename, type }
  })
}
