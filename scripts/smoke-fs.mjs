// 文件资源管理器流程：登录、列目录、建文件夹、multipart 上传（单文件 /
// 文件夹相对路径 / 超限 / 恶意路径）、删除、重命名、移动、文本预览与
// 原始文件流（下载头 / Range），以及隔离检查（路径越界被拒、未认证被拒）。
// 使用一次性 dataRoot + 内存数据库，每次运行完全隔离。
// maxFileBytes=64KB / previewBytes=32 让超限与截断分支无需大文件即可触发。
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildServer } from '../lib/web/server.js'
import { resolveConfig } from '../lib/config.js'
import { createUser } from '../lib/db/repo.js'
import { hashPassword } from '../lib/web/auth.js'
import { assert, cleanup, makeJson } from './helpers.mjs'

const dataRoot = mkdtempSync(join(tmpdir(), 'dsh-smoke-fs-'))
const app = await buildServer(
  resolveConfig({ port: 0, dbPath: ':memory:', dataRoot, maxFileBytes: 64 * 1024, previewBytes: 32 }),
)
await app.listen({ port: 0 })
const base = `http://127.0.0.1:${app.server.address().port}`

createUser(app.db, {
  id: 'u1',
  username: 'bob',
  passHash: await hashPassword('bobpass123'),
  role: 'active',
  homeDir: '/tmp/u1-home',
})

const json = makeJson(base)

/** multipart 上传封装：files = [{ name, data }]。 */
async function upload(cookie, path, files) {
  const fd = new FormData()
  fd.append('path', path)
  for (const f of files) fd.append('files', new Blob([f.data]), f.name)
  const res = await fetch(base + '/api/fs/upload', { method: 'POST', headers: { cookie }, body: fd })
  return { status: res.status, body: await res.json().catch(() => null) }
}

try {
  let r
  let res

  r = await json('/api/desktop/tree')
  assert(r.status === 401, '未认证的 tree 请求被拒绝')
  res = await fetch(base + '/api/fs/upload', { method: 'POST', body: new FormData() })
  assert(res.status === 401, '未认证的上传被拒绝')

  r = await json('/api/auth/login', { method: 'POST', body: { username: 'bob', password: 'bobpass123' } })
  assert(r.status === 200, '登录成功')
  const cookie = r.setCookie.split(';')[0]

  r = await json('/api/desktop/tree', { cookie })
  console.log('tree（空）      ->', r.status, r.body?.entries)
  assert(r.status === 200 && r.body.entries.length === 0, '空工作区列出零个条目')

  // ---------- 新建 ----------
  r = await json('/api/fs/mkdir', { method: 'POST', cookie, body: { path: 'proj' } })
  console.log('mkdir proj      ->', r.status)
  assert(r.status === 200, 'mkdir 成功')

  r = await json('/api/fs/mkdir', { method: 'POST', cookie, body: { path: 'proj/sub' } })
  console.log('mkdir proj/sub  ->', r.status)
  assert(r.status === 200, '嵌套 mkdir 成功')

  // 隔离检查：*path* 里出现 `..` 直接被拒绝
  r = await json('/api/fs/mkdir', { method: 'POST', cookie, body: { path: '../escape' } })
  console.log('mkdir ../escape ->', r.status)
  assert(r.status === 400, '路径越界被拒绝')

  r = await json('/api/fs/delete', { method: 'POST', cookie, body: { path: '' } })
  console.log('delete 根       ->', r.status)
  assert(r.status === 400, '删除工作区根本身被拒绝')

  // ---------- multipart 上传 ----------
  r = await upload(cookie, 'proj', [{ name: 'hello.txt', data: 'hi there' }])
  console.log('上传单文件      ->', r.status, r.body)
  assert(r.status === 200 && r.body?.ok === true && r.body?.count === 1, 'multipart 单文件上传成功')

  r = await upload(cookie, 'proj', [
    { name: 'pack/a.txt', data: 'A' },
    { name: 'pack/inner/b.txt', data: 'B' },
  ])
  console.log('上传文件夹      ->', r.status, r.body)
  assert(r.status === 200 && r.body?.count === 2, '文件夹上传保留目录结构')

  r = await json('/api/desktop/tree?path=proj/pack/inner', { cookie })
  assert(r.status === 200 && r.body.entries.some((e) => e.name === 'b.txt'), '子目录文件落盘正确')
  r = await json('/api/desktop/tree?path=proj', { cookie })
  assert(r.status === 200 && r.body.entries.some((e) => e.name === 'hello.txt'), '上传的文件出现在列表中')
  assert(r.body.entries.some((e) => e.name === 'pack' && e.type === 'dir'), '上传的文件夹出现在列表中')

  r = await upload(cookie, 'proj', [{ name: '../../evil.txt', data: 'x' }])
  console.log('upload ../      ->', r.status)
  assert(r.status === 400, '上传路径含 .. 被拒绝')

  r = await upload(cookie, 'proj', [{ name: 'C:\\evil.txt', data: 'x' }])
  console.log('upload C:\\     ->', r.status)
  assert(r.status === 400, '上传路径含盘符被拒绝')

  r = await upload(cookie, 'proj', [{ name: '/abs/path.txt', data: 'x' }])
  console.log('upload /abs     ->', r.status)
  assert(r.status === 200, '绝对路径上传被净化为相对子路径')
  r = await json('/api/desktop/tree?path=proj/abs', { cookie })
  assert(r.status === 200 && r.body.entries.some((e) => e.name === 'path.txt'), '净化后的文件落在目标目录内')

  // 旧 JSON 上传接口已由 multipart 取代
  r = await json('/api/fs/upload', { method: 'POST', cookie, body: { path: 'proj', name: 'x.txt', data: 'aGk=' } })
  console.log('upload JSON     ->', r.status)
  assert(r.status === 400, 'JSON 体上传被拒绝（要求 multipart）')

  // 超限：64KB 上限，传 100KB
  r = await upload(cookie, 'proj', [{ name: 'big.bin', data: Buffer.alloc(100 * 1024, 7) }])
  console.log('上传超限        ->', r.status)
  assert(r.status === 413, '超过单文件上限返回 413')
  r = await json('/api/desktop/tree?path=proj', { cookie })
  assert(!r.body.entries.some((e) => e.name === 'big.bin' || e.name.includes('uploading')), '超限残片已被清理')

  // ---------- 文本预览 ----------
  r = await json('/api/fs/read?path=' + encodeURIComponent('proj/hello.txt'), { cookie })
  console.log('read hello.txt  ->', r.status, JSON.stringify(r.body?.text))
  assert(r.status === 200 && r.body.text === 'hi there' && r.body.truncated === false, '文本预览返回内容')

  r = await upload(cookie, 'proj', [{ name: 'long.txt', data: 'x'.repeat(100) }])
  assert(r.status === 200, '上传长文本')
  r = await json('/api/fs/read?path=' + encodeURIComponent('proj/long.txt'), { cookie })
  assert(r.status === 200 && r.body.truncated === true && r.body.text.length === 32, '超长文本被截断到 previewBytes')

  r = await upload(cookie, 'proj', [{ name: 'blob.bin', data: Buffer.from([0, 1, 2, 0, 4]) }])
  assert(r.status === 200, '上传二进制')
  r = await json('/api/fs/read?path=' + encodeURIComponent('proj/blob.bin'), { cookie })
  assert(r.status === 415 && r.body.error === 'binary', '二进制文件预览返回 415')

  r = await json('/api/fs/read?path=proj', { cookie })
  assert(r.status === 400, '对目录预览返回 400')
  r = await json('/api/fs/read?path=nope.txt', { cookie })
  assert(r.status === 404, '预览不存在的文件返回 404')

  // ---------- 原始流 / 下载 / Range ----------
  res = await fetch(base + '/api/fs/raw?path=' + encodeURIComponent('proj/hello.txt') + '&download=1', { headers: { cookie } })
  assert(res.status === 200, 'raw 下载 200')
  assert(Buffer.from(await res.arrayBuffer()).toString() === 'hi there', 'raw 字节一致')
  const disp = res.headers.get('content-disposition') || ''
  assert(disp.startsWith('attachment') && disp.includes(encodeURIComponent('hello.txt')), '下载响应带 RFC5987 文件名')

  res = await fetch(base + '/api/fs/raw?path=' + encodeURIComponent('proj/hello.txt'), { headers: { cookie } })
  assert(res.headers.get('content-security-policy') === 'sandbox', 'inline 响应带 CSP sandbox')
  assert(res.headers.get('content-type')?.startsWith('text/plain'), 'text 扩展名映射正确')

  res = await fetch(base + '/api/fs/raw?path=' + encodeURIComponent('proj/hello.txt'), { headers: { cookie, range: 'bytes=3-5' } })
  assert(res.status === 206 && Buffer.from(await res.arrayBuffer()).toString() === 'the', 'Range 请求返回 206 与对应字节')
  assert(res.headers.get('content-range') === 'bytes 3-5/8', 'Content-Range 正确')

  res = await fetch(base + '/api/fs/raw?path=' + encodeURIComponent('proj/hello.txt'), { headers: { cookie, range: 'bytes=900-999' } })
  assert(res.status === 416, '不可满足的 Range 返回 416')

  // ---------- 重命名 ----------
  r = await json('/api/fs/rename', { method: 'POST', cookie, body: { path: 'proj/hello.txt', name: 'hi.txt' } })
  console.log('rename          ->', r.status)
  assert(r.status === 200, '重命名成功')
  r = await json('/api/fs/rename', { method: 'POST', cookie, body: { path: 'proj/hi.txt', name: 'long.txt' } })
  assert(r.status === 409, '重命名到已存在名返回 409')
  r = await json('/api/fs/rename', { method: 'POST', cookie, body: { path: 'proj/ghost.txt', name: 'x.txt' } })
  assert(r.status === 404, '重命名不存在的文件返回 404')

  // ---------- 移动 ----------
  r = await json('/api/fs/move', { method: 'POST', cookie, body: { path: 'proj/hi.txt', dest: 'proj/sub' } })
  console.log('move 文件       ->', r.status)
  assert(r.status === 200, '移动文件成功')
  r = await json('/api/desktop/tree?path=proj/sub', { cookie })
  assert(r.body.entries.some((e) => e.name === 'hi.txt'), '文件出现在目标目录')

  r = await json('/api/fs/move', { method: 'POST', cookie, body: { path: 'proj', dest: 'proj/sub' } })
  assert(r.status === 400, '目录移动进自身子目录被拒绝')

  r = await upload(cookie, 'proj', [
    { name: 'dup.txt', data: 'D1' },
    { name: 'sub/dup.txt', data: 'D2' },
  ])
  assert(r.status === 200, '构造同名冲突文件')
  r = await json('/api/fs/move', { method: 'POST', cookie, body: { path: 'proj/dup.txt', dest: 'proj/sub' } })
  assert(r.status === 409, '移动到同名已存在目标返回 409')

  r = await json('/api/fs/move', { method: 'POST', cookie, body: { path: 'proj/pack/inner', dest: 'nope' } })
  assert(r.status === 404, '目标目录不存在返回 404')

  // ---------- 文本编辑保存 ----------
  r = await json('/api/fs/write', { method: 'POST', cookie, body: { path: 'proj/sub/hi.txt', content: 'edited!' } })
  console.log('write 编辑      ->', r.status)
  assert(r.status === 200 && r.body.size === 7, '保存修改成功')
  r = await json('/api/fs/read?path=' + encodeURIComponent('proj/sub/hi.txt'), { cookie })
  assert(r.body.text === 'edited!', '读回编辑后的内容')
  r = await json('/api/fs/write', { method: 'POST', cookie, body: { path: 'proj', content: 'x' } })
  assert(r.status === 400 && r.body.error === 'is_dir', '对目录写入返回 400')
  r = await json('/api/fs/write', { method: 'POST', cookie, body: { path: 'ghost.txt', content: 'x' } })
  assert(r.status === 404, '写不存在的文件返回 404（编辑只覆盖已有文件）')
  r = await json('/api/fs/write', { method: 'POST', cookie, body: { path: '../evil.txt', content: 'x' } })
  assert(r.status === 400, '路径越界写入被拒绝')

  // ---------- 目录 zip 下载 ----------
  res = await fetch(base + '/api/fs/zip?path=proj', { headers: { cookie } })
  console.log('zip 目录        ->', res.status)
  assert(res.status === 200, 'zip 下载 200')
  assert((res.headers.get('content-type') || '').includes('zip'), 'zip content-type 正确')
  const zipBytes = Buffer.from(await res.arrayBuffer())
  assert(zipBytes.length > 100 && zipBytes[0] === 0x50 && zipBytes[1] === 0x4b, '响应体是 zip（PK 魔数）')
  res = await fetch(base + '/api/fs/zip?path=proj/ghost', { headers: { cookie } })
  assert(res.status === 404, 'zip 不存在目录返回 404')
  res = await fetch(base + '/api/fs/zip?path=' + encodeURIComponent('proj/dup.txt'), { headers: { cookie } })
  assert(res.status === 400, 'zip 对文件返回 400')

  // ---------- 全工作区搜索 ----------
  r = await json('/api/fs/search?q=dup', { cookie })
  console.log('search dup      ->', r.status, r.body?.results?.length)
  assert(r.status === 200 && r.body.results.length === 2, '搜索命中 proj/dup.txt 与 proj/sub/dup.txt')
  assert(r.body.results.every((h) => h.path.includes('dup')), '结果路径包含关键词')
  r = await json('/api/fs/search?q=zzz-nothing', { cookie })
  assert(r.status === 200 && r.body.results.length === 0, '无命中返回空结果')
  r = await json('/api/fs/search?q=', { cookie })
  assert(r.status === 400, '空关键词返回 400')

  // ---------- 删除 ----------
  r = await json('/api/fs/delete', { method: 'POST', cookie, body: { path: 'proj/long.txt' } })
  console.log('delete 文件     ->', r.status)
  assert(r.status === 200, '删除文件成功')
  r = await json('/api/desktop/tree?path=proj', { cookie })
  assert(!r.body.entries.some((e) => e.name === 'long.txt'), '删除后列表不再包含')

  r = await json('/api/fs/delete', { method: 'POST', cookie, body: { path: 'proj/pack' } })
  assert(r.status === 200, '递归删除文件夹成功')
  r = await json('/api/desktop/tree?path=proj/pack', { cookie })
  assert(r.status === 404, '删除后的目录不可再列出')

  r = await json('/api/fs/delete', { method: 'POST', cookie, body: { path: 'proj/ghost.txt' } })
  assert(r.status === 404, '删除不存在的条目返回 404')

  console.log('OK: 文件资源管理器流程 + 隔离检查通过')
} finally {
  await app.close()
  cleanup(dataRoot)
}
