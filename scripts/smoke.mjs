// 冒烟测试：在临时端口启动编排器，请求 `/` 与 `/api/auth/me`，然后干净关闭。
// 验证脚手架可编译、可迁移数据库、可服务静态文件，并检验认证守卫。
import { buildServer } from '../lib/web/server.js'
import { resolveConfig } from '../lib/config.js'
import { assert } from './helpers.mjs'

const app = await buildServer(resolveConfig({ port: 0, dbPath: ':memory:' }))
try {
  await app.listen({ port: 0 })
  const base = `http://127.0.0.1:${app.server.address().port}`

  const home = await fetch(base + '/')
  const homeText = await home.text()
  console.log('GET /            ->', home.status, homeText.replace(/\s+/g, ' ').slice(0, 60))
  assert(home.status === 200, '静态根路径返回 HTML')
  assert(homeText.includes('<!doctype html'), '静态根路径是 SPA 外壳')

  const me = await fetch(base + '/api/auth/me')
  console.log('GET /api/auth/me ->', me.status, await me.text())
  assert(me.status === 401, '认证守卫拒绝匿名 /me')

  console.log('OK: 启动、迁移、服务、关闭全部完成')
} finally {
  await app.close()
}
