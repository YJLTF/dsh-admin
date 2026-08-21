// 端到端认证 + 审核流程：植入一个管理员，注册一个用户，验证其待审核期间
// 无法登录，审核通过后再验证登录 + /me。
import { buildServer } from '../lib/web/server.js'
import { resolveConfig } from '../lib/config.js'
import { createUser } from '../lib/db/repo.js'
import { hashPassword } from '../lib/web/auth.js'
import { assert, makeJson } from './helpers.mjs'

const app = await buildServer(resolveConfig({ port: 0, dbPath: ':memory:' }))
await app.listen({ port: 0 })
const base = `http://127.0.0.1:${app.server.address().port}`

// 直接植入第一个管理员（即 `bootstrap-admin` 做的事）。
createUser(app.db, {
  id: 'admin-1',
  username: 'admin',
  passHash: await hashPassword('adminpass123'),
  role: 'admin',
  homeDir: '/tmp/admin-home',
})

const json = makeJson(base)

const sid = (setCookie) => (setCookie ? setCookie.split(';')[0] : undefined)

let r

r = await json('/api/auth/register', { method: 'POST', body: { username: 'alice', password: 'alicepass123' } })
console.log('注册 alice          ->', r.status)
assert(r.status === 201, '注册创建待审核用户')

r = await json('/api/auth/login', { method: 'POST', body: { username: 'alice', password: 'alicepass123' } })
console.log('登录 alice（待审核） ->', r.status, r.body?.error)
assert(r.status === 403 && r.body?.error === 'pending_review', '待审核用户被拒绝登录')

r = await json('/api/auth/login', { method: 'POST', body: { username: 'admin', password: 'adminpass123' } })
console.log('登录 admin           ->', r.status)
assert(r.status === 200, '管理员登录成功')
const adminCookie = sid(r.setCookie)

r = await json('/api/admin/users', { cookie: adminCookie })
console.log('用户列表             ->', r.status, r.body?.users?.map((u) => `${u.username}:${u.role}`))
assert(r.status === 200, '管理员可以列出用户')
const alice = r.body.users.find((u) => u.username === 'alice')
assert(alice?.role === 'pending', 'alice 列为待审核')

r = await json(`/api/admin/users/${alice.id}/approve`, { method: 'POST', cookie: adminCookie })
console.log('审核通过 alice       ->', r.status)
assert(r.status === 200, '审核通过成功')

r = await json('/api/auth/login', { method: 'POST', body: { username: 'alice', password: 'alicepass123' } })
console.log('登录 alice（已审核） ->', r.status, r.body?.user)
assert(r.status === 200 && r.body.user.role === 'active', '已审核用户登录成功')
const aliceCookie = sid(r.setCookie)

r = await json('/api/auth/me', { cookie: aliceCookie })
console.log('me（alice）          ->', r.status, r.body?.user)
assert(r.status === 200 && r.body.user.username === 'alice', '/me 返回当前用户')

r = await json('/api/me/keys', { cookie: aliceCookie })
console.log('keys（已移除）       ->', r.status)
assert(r.status === 404, '密钥库路由已移除')

await app.close()
console.log('OK: 完整认证 + 审核流程通过')
