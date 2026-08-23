/**
 * 文件资源管理器路由：列目录、新建、上传（multipart 流式）、删除、
 * 重命名、移动、文本预览与文件下载。
 * 每个路径都规范到调用者自己的工作区根目录之下，
 * 因此一个用户永远无法寻址另一个用户的文件。
 * @module dsh-admin/web/routes/fs
 */

import type { FastifyPluginAsync } from 'fastify'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, open, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { pipeline } from 'node:stream/promises'
import { ZipArchive } from 'archiver'
import { basename, dirname, join, sep } from 'node:path'
import { requireAuth } from '../middleware/authn.js'
import { resolveUserPath, resolveWithinRoot, safeFilename } from '../middleware/fs-guard.js'
import { listDir, statEntry, workspaceRoot } from '../../fs/workspace.js'
import { isTextByExtension, lookupMime, sniffIsBinary } from '../../fs/mime.js'

const pathSchema = { type: 'string', maxLength: 512 }

const mkdirSchema = {
  body: {
    type: 'object',
    required: ['path'],
    additionalProperties: false,
    properties: { path: pathSchema },
  },
} as const

const createSchema = {
  body: {
    type: 'object',
    required: ['path', 'name', 'type'],
    additionalProperties: false,
    properties: {
      path: pathSchema,
      name: { type: 'string', maxLength: 255 },
      type: { type: 'string', enum: ['file', 'dir'] },
    },
  },
} as const

const deleteSchema = {
  body: {
    type: 'object',
    required: ['path'],
    additionalProperties: false,
    properties: { path: pathSchema },
  },
} as const

const renameSchema = {
  body: {
    type: 'object',
    required: ['path', 'name'],
    additionalProperties: false,
    properties: { path: pathSchema, name: { type: 'string', maxLength: 255 } },
  },
} as const

const moveSchema = {
  body: {
    type: 'object',
    required: ['path', 'dest'],
    additionalProperties: false,
    properties: { path: pathSchema, dest: pathSchema },
  },
} as const

const writeSchema = {
  body: {
    type: 'object',
    required: ['path', 'content'],
    additionalProperties: false,
    properties: {
      path: pathSchema,
      // 请求体上限 = 全局 bodyLimit（maxUploadBytes）；落盘再按
      // maxFileBytes 复核一次。
      content: { type: 'string' },
    },
  },
} as const

/**
 * 净化上传文件名里的相对路径（文件夹上传时浏览器会把
 * `目录/子目录/文件` 整串放进 filename 字段）。逐段校验：拒绝
 * 空/`.`/`..`/含 NUL 或盘符冒号的段；返回以 `/` 连接的安全相对
 * 路径，非法输入返回 null。最终落盘位置还会再过一次
 * {@link resolveWithinRoot} 兜底。
 */
function sanitizeRelPath(raw: string | undefined): string | null {
  if (raw === undefined || raw === '') return null
  const segments = raw.split(/[\\/]+/).filter((s) => s !== '')
  const clean: string[] = []
  for (const seg of segments) {
    if (seg === '.' || seg === '..' || seg.includes('\0') || seg.includes(':') || seg.length > 255) {
      return null
    }
    clean.push(seg)
  }
  return clean.length > 0 ? clean.join('/') : null
}

/** RFC 5987 编码的 Content-Disposition，保证中文文件名不乱码。 */
function contentDisposition(kind: 'inline' | 'attachment', name: string): string {
  return `${kind}; filename*=UTF-8''${encodeURIComponent(name)}`
}

/**
 * 解析单段 `Range: bytes=start-end` 请求。返回 null 表示无 Range
 * 头（全量响应），`'invalid'` 表示语法正确但区间不可满足（416）。
 */
function parseRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | 'invalid' | null {
  if (header === undefined) return null
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (m === null || (m[1] === '' && m[2] === '')) return 'invalid'
  let start: number
  let end: number
  if (m[1] === '') {
    // 后缀区间 `bytes=-N`：最后 N 字节
    const suffix = Number(m[2])
    if (suffix === 0) return 'invalid'
    start = Math.max(0, size - suffix)
    end = size - 1
  } else {
    start = Number(m[1])
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1)
  }
  if (start > end || start >= size) return 'invalid'
  return { start, end }
}

/** 全局搜索结果上限：超大工作区里键盘每敲一个字符都可能触发
 * 一次全树遍历，封顶保护响应时间与前端渲染。 */
const SEARCH_LIMIT = 200

interface SearchHit {
  path: string
  name: string
  type: 'file' | 'dir'
  size: number
  mtimeMs: number
}

/** 递归收集名称包含 `needle`（大小写不敏感）的条目，塞满
 * SEARCH_LIMIT 即停。符号链接目录不深入（防环）。 */
async function searchTree(root: string, relBase: string, needle: string, out: SearchHit[]): Promise<void> {
  if (out.length >= SEARCH_LIMIT) return
  const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (out.length >= SEARCH_LIMIT) return
    const rel = relBase === '' ? entry.name : `${relBase}/${entry.name}`
    if (entry.name.toLowerCase().includes(needle)) {
      const st = await stat(join(root, entry.name)).catch(() => null)
      out.push({
        path: rel,
        name: entry.name,
        type: entry.isDirectory() ? 'dir' : 'file',
        size: st?.isFile() ? st.size : 0,
        mtimeMs: st?.mtimeMs ?? 0,
      })
    }
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      await searchTree(join(root, entry.name), rel, needle, out)
    }
  }
}

export const fsRoutes: FastifyPluginAsync = async (app) => {
  const config = app.config

  /** resolveUserPath + 拒绝把工作区根本身当作操作对象。 */
  function resolveEntry(userId: string, relPath: string): { ok: true; abs: string } | { ok: false; error: string } {
    const p = resolveUserPath(config, userId, relPath)
    if (!p.ok) return { ok: false, error: 'bad_path' }
    if (p.abs === workspaceRoot(config, userId)) return { ok: false, error: 'bad_path' }
    return p
  }

  app.get('/api/desktop/tree', { preHandler: requireAuth }, async (request, reply) => {
    const { path = '' } = request.query as { path?: string }
    const p = resolveUserPath(config, request.user!.id, path)
    if (!p.ok) return reply.code(400).send({ error: 'bad_path' })
    try {
      return { path, entries: await listDir(p.abs) }
    } catch {
      return reply.code(404).send({ error: 'not_found' })
    }
  })

  app.post('/api/fs/mkdir', { preHandler: requireAuth, schema: mkdirSchema }, async (request, reply) => {
    const { path } = request.body as { path: string }
    const p = resolveUserPath(config, request.user!.id, path)
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

  app.post('/api/fs/create', { preHandler: requireAuth, schema: createSchema }, async (request, reply) => {
    const { path, name, type } = request.body as { path: string; name: string; type: 'file' | 'dir' }
    const p = resolveUserPath(config, request.user!.id, path)
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

  /**
   * multipart 流式上传。字段 `path` 指定目标目录，其后跟随 1..N 个
   * 文件 part；文件夹上传时 part 的 filename 携带相对路径
   * （preservePath），逐级建目录后流式写盘。先写临时文件再原子
   * rename，客户端中途断开不会留下半个目标文件。
   */
  app.post('/api/fs/upload', { preHandler: requireAuth }, async (request, reply) => {
    if (!request.isMultipart()) return reply.code(400).send({ error: 'expected_multipart' })
    const userId = request.user!.id
    let destAbs: string | null = null
    let tmp: string | null = null
    let count = 0
    try {
      for await (const part of request.parts()) {
        if (part.type === 'field') {
          if (part.fieldname === 'path' && destAbs === null) {
            const p = resolveUserPath(config, userId, String(part.value))
            if (!p.ok) return reply.code(400).send({ error: 'bad_path' })
            destAbs = p.abs
          }
          continue
        }
        if (destAbs === null) return reply.code(400).send({ error: 'missing_path' })
        const rel = sanitizeRelPath(part.filename)
        if (rel === null) return reply.code(400).send({ error: 'bad_name' })
        const target = resolveWithinRoot(destAbs, rel)
        await mkdir(dirname(target), { recursive: true })
        // 临时名带随机后缀：同一目标的并发上传不会共享半截写入
        // （或因同时 rename 同一个临时文件而互相破坏）。
        tmp = `${target}..uploading-${randomBytes(6).toString('hex')}`
        await pipeline(part.file, createWriteStream(tmp))
        if (part.file.truncated) {
          await rm(tmp, { force: true })
          tmp = null
          return reply.code(413).send({ error: 'too_large' })
        }
        await rename(tmp, target)
        tmp = null
        count++
      }
    } catch (err) {
      if (tmp !== null) await rm(tmp, { force: true }).catch(() => {})
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENOENT') return reply.code(404).send({ error: 'parent_missing' })
      throw err
    }
    if (destAbs === null) return reply.code(400).send({ error: 'missing_path' })
    return { ok: true, count }
  })

  app.post('/api/fs/delete', { preHandler: requireAuth, schema: deleteSchema }, async (request, reply) => {
    const { path } = request.body as { path: string }
    const p = resolveEntry(request.user!.id, path)
    if (!p.ok) return reply.code(400).send({ error: p.error })
    try {
      await rm(p.abs, { recursive: true, force: false })
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return reply.code(404).send({ error: 'not_found' })
      throw err
    }
    return { ok: true }
  })

  app.post('/api/fs/rename', { preHandler: requireAuth, schema: renameSchema }, async (request, reply) => {
    const { path, name } = request.body as { path: string; name: string }
    const p = resolveEntry(request.user!.id, path)
    if (!p.ok) return reply.code(400).send({ error: p.error })
    let filename: string
    try {
      filename = safeFilename(name)
    } catch {
      return reply.code(400).send({ error: 'bad_name' })
    }
    const target = join(dirname(p.abs), filename)
    if (target === p.abs) return { ok: true }
    try {
      await stat(target)
      return reply.code(409).send({ error: 'exists' })
    } catch {
      // 目标不存在，继续改名。
    }
    try {
      await rename(p.abs, target)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return reply.code(404).send({ error: 'not_found' })
      throw err
    }
    return { ok: true, name: filename }
  })

  app.post('/api/fs/move', { preHandler: requireAuth, schema: moveSchema }, async (request, reply) => {
    const { path, dest } = request.body as { path: string; dest: string }
    const src = resolveEntry(request.user!.id, path)
    if (!src.ok) return reply.code(400).send({ error: src.error })
    const dst = resolveUserPath(config, request.user!.id, dest)
    if (!dst.ok) return reply.code(400).send({ error: 'bad_path' })
    let destSt
    try {
      destSt = await stat(dst.abs)
    } catch {
      return reply.code(404).send({ error: 'dest_not_found' })
    }
    if (!destSt.isDirectory()) return reply.code(400).send({ error: 'dest_not_dir' })
    // 把目录移动进它自己的子树会造出环。
    if (dst.abs === src.abs || dst.abs.startsWith(src.abs + sep)) {
      return reply.code(400).send({ error: 'invalid_dest' })
    }
    const target = join(dst.abs, basename(src.abs))
    try {
      await stat(target)
      return reply.code(409).send({ error: 'exists' })
    } catch {
      // 目标槽位空闲，可以移动。
    }
    try {
      await rename(src.abs, target)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return reply.code(404).send({ error: 'not_found' })
      throw err
    }
    return { ok: true }
  })

  /** 文本预览：按扩展名 + NUL 嗅探判定文本，最多返回 previewBytes。 */
  app.get('/api/fs/read', { preHandler: requireAuth }, async (request, reply) => {
    const { path = '' } = request.query as { path?: string }
    const p = resolveUserPath(config, request.user!.id, path)
    if (!p.ok) return reply.code(400).send({ error: 'bad_path' })
    let entry
    try {
      entry = await statEntry(p.abs)
    } catch {
      return reply.code(404).send({ error: 'not_found' })
    }
    if (entry.type === 'dir') return reply.code(400).send({ error: 'is_dir' })
    const fh = await open(p.abs, 'r').catch(() => null)
    if (fh === null) return reply.code(404).send({ error: 'not_found' })
    try {
      const cap = Math.min(entry.size, config.previewBytes)
      const buf = Buffer.alloc(cap)
      await fh.read(buf, 0, cap, 0)
      if (!isTextByExtension(entry.name) && sniffIsBinary(cap <= 8192 ? buf : buf.subarray(0, 8192))) {
        return reply.code(415).send({ error: 'binary' })
      }
      return {
        name: entry.name,
        size: entry.size,
        truncated: entry.size > cap,
        text: buf.toString('utf8'),
      }
    } finally {
      await fh.close()
    }
  })

  /**
   * 原始文件流（预览 inline / 下载 attachment）。inline 响应统一加
   * CSP sandbox + nosniff，上传的 HTML/SVG 无法在同源执行脚本；
   * 支持单段 Range 以便视频拖动进度。该路由关闭全局限流 —— 视频
   * 播放器会连续发出大量小 range 请求。
   */
  app.get(
    '/api/fs/raw',
    { preHandler: requireAuth, config: { rateLimit: false } },
    async (request, reply) => {
      const query = request.query as { path?: string; download?: string }
      const p = resolveUserPath(config, request.user!.id, query.path ?? '')
      if (!p.ok) return reply.code(400).send({ error: 'bad_path' })
      let st
      try {
        st = await stat(p.abs)
      } catch {
        return reply.code(404).send({ error: 'not_found' })
      }
      if (!st.isFile()) return reply.code(400).send({ error: 'is_dir' })
      const name = basename(p.abs)
      const download = query.download === '1'
      reply.header('content-type', lookupMime(name))
      reply.header('x-content-type-options', 'nosniff')
      reply.header('accept-ranges', 'bytes')
      reply.header('content-disposition', contentDisposition(download ? 'attachment' : 'inline', name))
      if (!download) {
        // inline 内容会被浏览器渲染：沙箱化，杜绝同源脚本执行。
        reply.header('content-security-policy', 'sandbox')
      }
      const range = parseRange(request.headers.range, st.size)
      if (range === 'invalid') {
        reply.code(416).header('content-range', `bytes */${st.size}`)
        return reply.send()
      }
      if (range !== null) {
        const length = range.end - range.start + 1
        reply.code(206)
        reply.header('content-range', `bytes ${range.start}-${range.end}/${st.size}`)
        reply.header('content-length', length)
        return reply.send(createReadStream(p.abs, { start: range.start, end: range.end }))
      }
      reply.header('content-length', st.size)
      return reply.send(createReadStream(p.abs))
    },
  )

  /** 文本编辑保存：覆盖写已有文件（同上传的临时文件 + 原子 rename
   * 模式，半截写入不会破坏原文件）。目录与越界路径拒绝。 */
  app.post('/api/fs/write', { preHandler: requireAuth, schema: writeSchema }, async (request, reply) => {
    const { path, content } = request.body as { path: string; content: string }
    const p = resolveEntry(request.user!.id, path)
    if (!p.ok) return reply.code(400).send({ error: p.error })
    if (Buffer.byteLength(content, 'utf8') > config.maxFileBytes) {
      return reply.code(413).send({ error: 'too_large' })
    }
    let existing
    try {
      existing = await stat(p.abs)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return reply.code(404).send({ error: 'not_found' })
      throw err
    }
    if (!existing.isFile()) return reply.code(400).send({ error: 'is_dir' })
    const tmp = `${p.abs}..editing-${randomBytes(6).toString('hex')}`
    try {
      await writeFile(tmp, content, 'utf8')
      await rename(tmp, p.abs)
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => {})
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENOENT') return reply.code(404).send({ error: 'parent_missing' })
      throw err
    }
    return { ok: true, size: Buffer.byteLength(content, 'utf8') }
  })

  /** 目录打包下载：流式 zip（archiver），边压缩边发送，服务器不落
   * 临时压缩包。路径已被 fs-guard 规范在工作区内，archiver 只从该
   * 目录读；符号链接以链接条目存储、不跟随。关闭限流与 /api/fs/raw
   * 同理（大目录下载是长连接）。 */
  app.get(
    '/api/fs/zip',
    { preHandler: requireAuth, config: { rateLimit: false } },
    async (request, reply) => {
      const { path = '' } = request.query as { path?: string }
      const p = resolveUserPath(config, request.user!.id, path)
      if (!p.ok) return reply.code(400).send({ error: 'bad_path' })
      let st
      try {
        st = await stat(p.abs)
      } catch {
        return reply.code(404).send({ error: 'not_found' })
      }
      if (!st.isDirectory()) return reply.code(400).send({ error: 'is_dir' })
      const folderName = basename(p.abs) || 'workspace'
      // archiver v8：格式即类（ZipArchive），流式边压缩边发送。
      const archive = new ZipArchive({ zlib: { level: 6 } })
      archive.on('error', () => {
        // 压缩中途出错（文件被并发删除等）：销毁底层连接，浏览器
        // 按下载失败处理，而不是收到截断的 zip。
        reply.raw.destroy()
      })
      // zip 根为目录本身，解压得到单个文件夹而不是散落一地。
      void archive.directory(p.abs, folderName).finalize()
      reply.header('content-type', 'application/zip')
      reply.header('content-disposition', contentDisposition('attachment', `${folderName}.zip`))
      return reply.send(archive)
    },
  )

  /** 全局搜索：按名称匹配（大小写不敏感），封顶 SEARCH_LIMIT 条。 */
  app.get('/api/fs/search', { preHandler: requireAuth }, async (request, reply) => {
    const { q = '' } = request.query as { q?: string }
    const needle = q.trim().toLowerCase()
    if (needle === '') return reply.code(400).send({ error: 'empty_query' })
    if (needle.length > 256) return reply.code(400).send({ error: 'query_too_long' })
    const results: SearchHit[] = []
    await searchTree(workspaceRoot(config, request.user!.id), '', needle, results)
    return { query: q, results, hasMore: results.length >= SEARCH_LIMIT }
  })
}
