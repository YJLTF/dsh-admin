// 每文件夹插件流程：列出插件目录、持久化勾选，然后启动并验证勾选被注入
// （patch 文件 + --patch 参数）。
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildServer } from '../lib/web/server.js'
import { resolveConfig } from '../lib/config.js'
import { createUser } from '../lib/db/repo.js'
import { hashPassword } from '../lib/web/auth.js'
import { assert, makeJson } from './helpers.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const fakeDsh = join(here, 'fake-dsh.mjs')
const dataRoot = mkdtempSync(join(tmpdir(), 'dsh-smoke-plugins-'))

const app = await buildServer(
  resolveConfig({
    port: 0,
    dbPath: ':memory:',
    dataRoot,
    dshCommand: [process.execPath, fakeDsh],
    enablePatch: true,
  }),
)
await app.listen({ port: 0 })
const base = `http://127.0.0.1:${app.server.address().port}`

createUser(app.db, {
  id: 'u1',
  username: 'dave',
  passHash: await hashPassword('davepass123'),
  role: 'active',
  homeDir: '/tmp/u1-home',
})
mkdirSync(join(dataRoot, 'users', 'u1', 'ws', 'proj'), { recursive: true })

// 往常驻 web profile 装两个用户 bundle（外加一个内置 `@deepseek-ai/*` bundle，
// 检测时必须跳过它）。
const profileDir = join(dataRoot, 'users', 'u1', 'home', 'profiles', 'web')
mkdirSync(join(profileDir, 'node_modules', 'p1'), { recursive: true })
mkdirSync(join(profileDir, 'node_modules', 'p2'), { recursive: true })
writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
  name: 'dsh-profile-web',
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'p1', 'p2'] } },
}))
writeFileSync(join(profileDir, 'node_modules', 'p1', 'package.json'), JSON.stringify({ name: 'p1', description: 'first' }))
writeFileSync(join(profileDir, 'node_modules', 'p2', 'package.json'), JSON.stringify({ name: 'p2', description: 'second' }))

const json = makeJson(base)

try {
  let r
  r = await json('/api/auth/login', { method: 'POST', body: { username: 'dave', password: 'davepass123' } })
  const cookie = r.setCookie.split(';')[0]

  r = await json('/api/plugins?folder=proj', { cookie })
  console.log('插件目录    ->', r.status, r.body?.plugins)
  assert(r.status === 200 && r.body.plugins.length === 2 && r.body.plugins.every((p) => !p.enabled), '目录已列出，无一启用')

  r = await json('/api/plugins/select', {
    method: 'POST',
    cookie,
    body: { folder: 'proj', plugins: [{ id: 'p1', enabled: true }, { id: 'p2', enabled: false }, { id: 'nope', enabled: true }] },
  })
  console.log('勾选        ->', r.status)
  assert(r.status === 200, '勾选成功')

  r = await json('/api/plugins?folder=proj', { cookie })
  console.log('勾选结果    ->', r.status, r.body?.plugins?.map((p) => `${p.id}:${p.enabled}`))
  assert(r.body.plugins.find((p) => p.id === 'p1').enabled === true, 'p1 已启用')
  assert(r.body.plugins.find((p) => p.id === 'p2').enabled === false, 'p2 未启用')

  r = await json('/api/dsh/launch', { method: 'POST', cookie, body: { folder: 'proj' } })
  console.log('启动        ->', r.status)
  assert(r.status === 200, '启动成功')
  const childPort = r.body.instance.port

  // patch 文件应挂载运行时插件且只启用 p1。
  const patchesDir = join(dataRoot, 'users', 'u1', 'patches')
  const files = readdirSync(patchesDir)
  assert(files.length === 1, '写出了一个 patch 文件')
  const patch = readFileSync(join(patchesDir, files[0]), 'utf8')
  console.log('patch       ->', JSON.stringify(patch))
  assert(patch.includes('dsh-admin/runtime'), 'patch 挂载了运行时插件')
  assert(patch.includes('p1') && !patch.includes('p2'), 'patch 只启用 p1')

  // 子进程的 argv 应包含 --patch。
  let childText
  for (let i = 0; i < 20; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${childPort}/hello`)
      if (res.status === 200) {
        childText = await res.text()
        break
      }
    } catch {
      // 重试直到子进程开始监听
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  console.log('子进程      ->', childText)
  assert(childText !== undefined && childText.includes('--patch'), '子进程收到了 --patch')

  console.log('OK: 每文件夹插件流程通过')
} finally {
  await app.close()
  await new Promise((resolve) => setTimeout(resolve, 300))
  try {
    rmSync(dataRoot, { recursive: true, force: true })
  } catch {
    // 尽力而为的清理：Windows 上子进程可能仍占用该目录
  }
}
