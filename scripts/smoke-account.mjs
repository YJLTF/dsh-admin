// 账号与会话安全流程：注册门禁（开关/邀请码）、自助改密（吊销其他会话）、
// 会话列表/吊销、管理员重置密码、审计日志（筛选/分页）、删除用户（含目录清理）。
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildServer } from '../lib/web/server.js'
import { resolveConfig } from '../lib/config.js'
import { createUser } from '../lib/db/repo.js'
import { hashPassword } from '../lib/web/auth.js'
import { assert, cleanup, makeJson } from './helpers.mjs'

const dataRoot = mkdtempSync(join(tmpdir(), 'dsh-smoke-account-'))
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
  role: 'active',
  homeDir: join(dataRoot, 'users', 'bob', 'home'),
})

const json = makeJson(base)

try {
  let r

  // ---------- 注册门禁 ----------
  r = await json('/api/meta')
  assert(r.status === 200 && r.body.allowRegister === true && r.body.inviteRequired === false, 'meta 默认开放注册')

  r = await json('/api/auth/register', { method: 'POST', body: { username: 'carol', password: 'carolpass123' } })
  assert(r.status === 201, '开放注册直接成功')
  const carolId = r.body.user.id

  r = await json('/api/admin/settings', { method: 'PUT', cookie: '', body: { allowRegister: false } })
  assert(r.status === 401, '未认证改设置被拒')

  // admin 登录
  r = await json('/api/auth/login', { method: 'POST', body: { username: 'admin', password: 'adminpass123' } })
  assert(r.status === 200 && r.setCookie, '管理员登录')
  const adminCookie = r.setCookie.split(';')[0]

  r = await json('/api/admin/settings', { method: 'PUT', cookie: adminCookie, body: { allowRegister: false } })
  assert(r.status === 200 && r.body.allowRegister === false, '关闭注册')
  r = await json('/api/meta')
  assert(r.body.allowRegister === false, 'meta 反映关闭状态')
  r = await json('/api/auth/register', { method: 'POST', body: { username: 'dave', password: 'davepass123' } })
  assert(r.status === 403 && r.body.error === 'registrations_disabled', '关闭后注册被拒')

  r = await json('/api/admin/settings', { method: 'PUT', cookie: adminCookie, body: { allowRegister: true, inviteCode: 'lan-2026' } })
  assert(r.status === 200 && r.body.inviteRequired === true, '设置邀请码')
  r = await json('/api/auth/register', { method: 'POST', body: { username: 'dave', password: 'davepass123' } })
  assert(r.status === 403 && r.body.error === 'invalid_invite', '缺邀请码被拒')
  r = await json('/api/auth/register', { method: 'POST', body: { username: 'dave', password: 'davepass123', inviteCode: 'wrong' } })
  assert(r.status === 403 && r.body.error === 'invalid_invite', '错邀请码被拒')
  r = await json('/api/auth/register', { method: 'POST', body: { username: 'dave', password: 'davepass123', inviteCode: 'lan-2026' } })
  assert(r.status === 201, '正确邀请码注册成功')
  // 清掉邀请码，后续注册不受影响。
  r = await json('/api/admin/settings', { method: 'PUT', cookie: adminCookie, body: { inviteCode: '' } })
  assert(r.status === 200 && r.body.inviteRequired === false, '清除邀请码')

  // ---------- 会话列表与吊销 ----------
  r = await json('/api/auth/login', { method: 'POST', body: { username: 'bob', password: 'bobpass123' } })
  assert(r.status === 200, 'bob 设备 A 登录')
  const cookieA = r.setCookie.split(';')[0]
  r = await json('/api/auth/login', { method: 'POST', body: { username: 'bob', password: 'bobpass123' } })
  assert(r.status === 200, 'bob 设备 B 登录')
  const cookieB = r.setCookie.split(';')[0]

  r = await json('/api/me/sessions', { cookie: cookieA })
  assert(r.status === 200 && r.body.sessions.length === 2, '列出两台设备')
  const currentA = r.body.currentId
  const otherB = r.body.sessions.find((s) => s.id !== currentA)
  assert(otherB !== undefined && r.body.sessions.every((s) => s.lastUsedAt > 0), '会话带最后活跃时间')

  r = await json('/api/me/sessions/' + encodeURIComponent(otherB.id), { method: 'DELETE', cookie: cookieA })
  assert(r.status === 200, '吊销设备 B')
  r = await json('/api/auth/me', { cookie: cookieB })
  assert(r.status === 401, '被吊销的会话立即失效')
  r = await json('/api/auth/me', { cookie: cookieA })
  assert(r.status === 200, '当前会话不受影响')
  // 越权：bob 吊销 admin 的会话 id。
  r = await json('/api/me/sessions/whatever-hash', { method: 'DELETE', cookie: cookieA })
  assert(r.status === 404, '吊销不属于自己的会话返回 404')

  // ---------- 自助改密 ----------
  r = await json('/api/me/password', { method: 'POST', cookie: cookieA, body: { currentPassword: 'wrong-pass', newPassword: 'newpass12345' } })
  assert(r.status === 401 && r.body.error === 'invalid_credentials', '旧密码错误被拒')
  r = await json('/api/me/password', { method: 'POST', cookie: cookieA, body: { currentPassword: 'bobpass123', newPassword: 'newpass12345' } })
  assert(r.status === 200, '改密成功')
  r = await json('/api/auth/login', { method: 'POST', body: { username: 'bob', password: 'bobpass123' } })
  assert(r.status === 401, '旧密码不再能登录')
  r = await json('/api/auth/login', { method: 'POST', body: { username: 'bob', password: 'newpass12345' } })
  assert(r.status === 200, '新密码可登录')
  const bobCookie2 = r.setCookie.split(';')[0]
  r = await json('/api/me/sessions', { cookie: cookieA })
  assert(r.status === 200 && r.body.sessions.length === 2, '改密后仅保留当前会话 + 之后的新登录（共 2）')

  // ---------- 管理员重置密码 ----------
  r = await json('/api/admin/users/bob/reset-password', { method: 'POST', cookie: adminCookie, body: { newPassword: 'resetpass123' } })
  assert(r.status === 200, '管理员重置 bob 密码')
  r = await json('/api/auth/me', { cookie: bobCookie2 })
  assert(r.status === 401, '重置后 bob 的既有会话全部吊销')
  r = await json('/api/auth/login', { method: 'POST', body: { username: 'bob', password: 'resetpass123' } })
  assert(r.status === 200, 'bob 用重置密码登录')

  // ---------- 审计日志 ----------
  r = await json('/api/admin/audit?limit=200', { cookie: adminCookie })
  assert(r.status === 200 && r.body.total > 0, '审计列表非空')
  const actions = new Set(r.body.rows.map((row) => row.action))
  for (const action of ['register', 'login', 'password_change', 'password_reset', 'settings_update', 'session_revoke']) {
    assert(actions.has(action), `审计包含 ${action}`)
  }
  r = await json('/api/admin/audit?action=password_reset&limit=10', { cookie: adminCookie })
  assert(r.status === 200 && r.body.rows.length === 1 && r.body.rows[0].action === 'password_reset', '按动作筛选')
  r = await json('/api/admin/audit?actor=admin&limit=10', { cookie: adminCookie })
  assert(r.status === 200 && r.body.rows.every((row) => row.actorName === 'admin' || row.actor === 'admin'), '按用户名筛选操作者')
  r = await json('/api/admin/audit?limit=1&page=2', { cookie: adminCookie })
  assert(r.status === 200 && r.body.rows.length === 1 && r.body.total > 1, '分页生效')

  // ---------- 删除用户 ----------
  // 审核通过 carol，让她有 home 目录与登录会话。
  r = await json('/api/admin/users/' + carolId + '/approve', { method: 'POST', cookie: adminCookie })
  assert(r.status === 200, '审核通过 carol')
  r = await json('/api/auth/login', { method: 'POST', body: { username: 'carol', password: 'carolpass123' } })
  assert(r.status === 200, 'carol 登录')
  assert(existsSync(join(dataRoot, 'users', carolId)), 'carol 的用户目录存在')

  r = await json('/api/admin/users/admin/delete', { method: 'POST', cookie: adminCookie })
  assert(r.status === 409 && r.body.error === 'cannot_delete_self', '管理员不能删除自己')
  r = await json('/api/admin/users/' + carolId + '/delete', { method: 'POST', cookie: adminCookie })
  assert(r.status === 200, '删除 carol 成功')
  assert(!existsSync(join(dataRoot, 'users', carolId)), 'carol 的用户目录已移除')
  r = await json('/api/admin/users', { cookie: adminCookie })
  assert(!r.body.users.some((u) => u.id === carolId), '用户列表不再包含 carol')
  r = await json('/api/auth/login', { method: 'POST', body: { username: 'carol', password: 'carolpass123' } })
  assert(r.status === 401, 'carol 不再能登录')
  r = await json('/api/admin/audit?action=user_delete&limit=5', { cookie: adminCookie })
  assert(r.body.rows.length === 1 && r.body.rows[0].detail.includes('carol'), '删除留有审计记录（含用户名）')

  console.log('OK: 账号与会话安全（门禁/改密/会话/审计/删用户）通过')
} finally {
  await app.close()
  cleanup(dataRoot)
}
