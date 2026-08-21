// 管理员账号流程：审核通过 → 禁用 → 启用（恢复），外加防护栏检查。
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildServer } from '../lib/web/server.js'
import { resolveConfig } from '../lib/config.js'
import { createUser } from '../lib/db/repo.js'
import { hashPassword } from '../lib/web/auth.js'
import { assert, makeJson } from './helpers.mjs'

const dataRoot = mkdtempSync(join(tmpdir(), 'dsh-smoke-admin-'))
const app = await buildServer(resolveConfig({ port: 0, dbPath: ':memory:', dataRoot }))
await app.listen({ port: 0 })
const base = `http://127.0.0.1:${app.server.address().port}`

createUser(app.db, {
  id: 'admin',
  username: 'admin',
  passHash: await hashPassword('adminpass123'),
  role: 'admin',
  homeDir: join(dataRoot, 'users', 'admin', 'home'),
})
createUser(app.db, {
  id: 'bob',
  username: 'bob',
  passHash: await hashPassword('bobpass123'),
  role: 'pending',
  homeDir: join(dataRoot, 'users', 'bob', 'home'),
})

const json = makeJson(base)

try {
  let r
  // 待审核用户不能登录。
  r = await json('/api/auth/login', { method: 'POST', body: { username: 'bob', password: 'bobpass123' } })
  assert(r.status === 403 && r.body.error === 'pending_review', '待审核用户被拦截登录')

  // 管理员登录。
  r = await json('/api/auth/login', { method: 'POST', body: { username: 'admin', password: 'adminpass123' } })
  assert(r.status === 200, '管理员登录成功')
  const cookie = r.setCookie.split(';')[0]

  // 审核通过 bob。
  r = await json('/api/admin/users/bob/approve', { method: 'POST', cookie })
  assert(r.status === 200, '审核通过成功')

  // bob 现在可以登录了。
  r = await json('/api/auth/login', { method: 'POST', body: { username: 'bob', password: 'bobpass123' } })
  assert(r.status === 200, '已审核用户登录成功')

  // 禁用 bob。
  r = await json('/api/admin/users/bob/disable', { method: 'POST', cookie })
  assert(r.status === 200, '禁用成功')

  // bob 再次被拦截（角色变为 disabled + 会话已清除）。
  r = await json('/api/auth/login', { method: 'POST', body: { username: 'bob', password: 'bobpass123' } })
  assert(r.status === 403 && r.body.error === 'disabled', '已禁用用户被拦截登录')

  // 启用（恢复）bob。
  r = await json('/api/admin/users/bob/enable', { method: 'POST', cookie })
  assert(r.status === 200, '启用成功')

  // bob 可以再次登录。
  r = await json('/api/auth/login', { method: 'POST', body: { username: 'bob', password: 'bobpass123' } })
  assert(r.status === 200, '恢复后的用户登录成功')

  // 防护栏检查。
  r = await json('/api/admin/users/bob/enable', { method: 'POST', cookie })
  assert(r.status === 409 && r.body.error === 'not_disabled', '对非禁用用户执行启用 → 409')
  r = await json('/api/admin/users/admin/disable', { method: 'POST', cookie })
  assert(r.status === 409 && r.body.error === 'cannot_disable_admin', '不能禁用管理员')

  console.log('OK: 管理员 审核/禁用/启用 流程通过')
} finally {
  await app.close()
  rmSync(dataRoot, { recursive: true, force: true })
}
