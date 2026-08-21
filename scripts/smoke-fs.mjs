// 桌面/文件系统流程：登录、列目录（空）、建文件夹（嵌套）、上传，以及隔离
// 检查（路径越界被拒、上传文件名被净化、未认证被拒）。
// 使用一次性 dataRoot + 内存数据库，每次运行完全隔离。
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildServer } from '../lib/web/server.js'
import { resolveConfig } from '../lib/config.js'
import { createUser } from '../lib/db/repo.js'
import { hashPassword } from '../lib/web/auth.js'
import { assert, makeJson } from './helpers.mjs'

const dataRoot = mkdtempSync(join(tmpdir(), 'dsh-smoke-fs-'))
const app = await buildServer(resolveConfig({ port: 0, dbPath: ':memory:', dataRoot }))
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

try {
  let r

  r = await json('/api/desktop/tree')
  assert(r.status === 401, '未认证的 tree 请求被拒绝')

  r = await json('/api/auth/login', { method: 'POST', body: { username: 'bob', password: 'bobpass123' } })
  assert(r.status === 200, '登录成功')
  const cookie = r.setCookie.split(';')[0]

  r = await json('/api/desktop/tree', { cookie })
  console.log('tree（空）      ->', r.status, r.body?.entries)
  assert(r.status === 200 && r.body.entries.length === 0, '空工作区列出零个条目')

  r = await json('/api/fs/mkdir', { method: 'POST', cookie, body: { path: 'proj' } })
  console.log('mkdir proj      ->', r.status)
  assert(r.status === 200, 'mkdir 成功')

  r = await json('/api/fs/mkdir', { method: 'POST', cookie, body: { path: 'proj/sub' } })
  console.log('mkdir proj/sub  ->', r.status)
  assert(r.status === 200, '嵌套 mkdir 成功')

  r = await json('/api/fs/upload', {
    method: 'POST',
    cookie,
    body: { path: 'proj', name: 'hello.txt', data: Buffer.from('hi there').toString('base64') },
  })
  console.log('上传            ->', r.status)
  assert(r.status === 200, '上传成功')

  r = await json('/api/desktop/tree?path=proj', { cookie })
  console.log('tree proj       ->', r.status, r.body?.entries?.map((e) => `${e.name}:${e.type}`))
  assert(r.status === 200 && r.body.entries.some((e) => e.name === 'hello.txt'), '上传的文件出现在列表中')

  // 隔离检查：*path* 里出现 `..` 直接被拒绝
  r = await json('/api/fs/mkdir', { method: 'POST', cookie, body: { path: '../escape' } })
  console.log('mkdir ../escape ->', r.status)
  assert(r.status === 400, '路径越界被拒绝')

  // 隔离检查：*name* 里的路径分量被净化为 basename
  r = await json('/api/fs/upload', {
    method: 'POST',
    cookie,
    body: { path: '', name: '../../evil.txt', data: 'aGk=' },
  })
  console.log('upload ../../   ->', r.status, r.body?.name)
  assert(r.status === 200 && r.body?.name === 'evil.txt', '上传文件名被净化为 basename')

  console.log('OK: 桌面/文件系统流程 + 隔离检查通过')
} finally {
  await app.close()
  rmSync(dataRoot, { recursive: true, force: true })
}
