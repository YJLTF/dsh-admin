// 针对 `dsh` 替身（fake-dsh.mjs）的 DSH 启动/状态/子进程转发/停止流程。
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildServer } from '../lib/web/server.js'
import { resolveConfig } from '../lib/config.js'
import { createUser } from '../lib/db/repo.js'
import { hashPassword } from '../lib/web/auth.js'
import { assert, makeJson } from './helpers.mjs'

// 尽力而为的临时目录清理：Windows 上刚被杀掉的子进程可能仍占用句柄几毫秒；
// 绝不让清理失败掩盖真正的断言失败。
function cleanup(dir) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  } catch (e) {
    console.log('清理已跳过：', e.code ?? e.message)
  }
}

const here = dirname(fileURLToPath(import.meta.url))
const fakeDsh = join(here, 'fake-dsh.mjs')
const dataRoot = mkdtempSync(join(tmpdir(), 'dsh-smoke-dsh-'))

const app = await buildServer(
  resolveConfig({ port: 0, dbPath: ':memory:', dataRoot, dshCommand: [process.execPath, fakeDsh] }),
)
await app.listen({ port: 0 })
const base = `http://127.0.0.1:${app.server.address().port}`

createUser(app.db, {
  id: 'u1',
  username: 'carol',
  passHash: await hashPassword('carolpass123'),
  role: 'active',
  homeDir: '/tmp/u1-home',
})
mkdirSync(join(dataRoot, 'users', 'u1', 'ws', 'proj'), { recursive: true })

const json = makeJson(base)

try {
  let r
  r = await json('/api/auth/login', { method: 'POST', body: { username: 'carol', password: 'carolpass123' } })
  assert(r.status === 200, '登录成功')
  const cookie = r.setCookie.split(';')[0]

  r = await json('/api/dsh/status', { cookie })
  assert(r.body.running === false, '初始状态未运行')

  r = await json('/api/dsh/launch', { method: 'POST', cookie, body: { folder: 'proj' } })
  console.log('启动    ->', r.status, r.body)
  assert(r.status === 200 && r.body.url, '启动成功')
  const url = r.body.url
  // dev 服务绑定回环端口 → url 必须是子进程自己的端口。
  assert(url === `http://127.0.0.1:${r.body.instance.port}/`, 'dev url 是子进程的回环端口')

  r = await json('/api/dsh/status', { cookie })
  console.log('状态    ->', r.status, r.body)
  assert(r.body.running === true, '启动后处于运行状态')

  // 子进程异步绑定端口；轮询直到它响应。
  let childText
  for (let i = 0; i < 20; i++) {
    try {
      const res = await fetch(new URL('hello', new URL(url, base)))
      if (res.status === 200) {
        childText = await res.text()
        break
      }
    } catch {
      // 子进程开始监听前连接被拒绝 —— 重试
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  console.log('子进程  ->', childText)
  assert(childText !== undefined && childText.includes('fake-dsh'), '子 DSH 在其端口上可达')

  // 内网模式：PUBLIC_HOST + 固定端口段 → 发布主机 URL。
  {
    const app2 = await buildServer(
      resolveConfig({
        port: 0,
        dbPath: ':memory:',
        dataRoot: mkdtempSync(join(tmpdir(), 'dsh-smoke-lan-')),
        dshCommand: [process.execPath, fakeDsh],
        publicHost: '192.168.1.100',
        host: '0.0.0.0',
        dshPortMin: 41000,
        dshPortMax: 41010,
      }),
    )
    await app2.listen({ port: 0, host: '127.0.0.1' })
    const base2 = `http://127.0.0.1:${app2.server.address().port}`
    createUser(app2.db, {
      id: 'u1',
      username: 'carol',
      passHash: await hashPassword('carolpass123'),
      role: 'active',
      homeDir: '/tmp/u1-home',
    })
    mkdirSync(join(app2.config.dataRoot, 'users', 'u1', 'ws', 'proj'), { recursive: true })
    const res = await fetch(base2 + '/api/dsh/launch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ folder: 'proj' }),
    })
    assert(res.status === 401, '未登录的启动请求被拒绝')
    const login = await fetch(base2 + '/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'carol', password: 'carolpass123' }),
    })
    const cookie2 = login.headers.get('set-cookie').split(';')[0]
    const res2 = await fetch(base2 + '/api/dsh/launch', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookie2 },
      body: JSON.stringify({ folder: 'proj' }),
    })
    const body2 = await res2.json()
    console.log('内网    ->', res2.status, body2.url, '端口', body2.instance.port)
    assert(res2.status === 200 && body2.url === `http://192.168.1.100:${body2.instance.port}/`, 'publicHost 的 url')
    assert(body2.instance.port >= 41000 && body2.instance.port <= 41010, '子进程端口在配置范围内')

    // 转发器（绑定本机真实 IP）代理时必须剥掉 Origin 头，
    // 并向 HTML 注入 randomUUID polyfill。
    {
      const os = await import('node:os')
      const lanIp = Object.values(os.networkInterfaces())
        .flat()
        .find((i) => i && i.family === 'IPv4' && !i.internal)?.address
      if (lanIp !== undefined) {
        const fwdBase = `http://${lanIp}:${body2.instance.port}`
        console.log('经转发器 ->', fwdBase)
        // 转发器在启动后异步绑定；稍等片刻。
        await new Promise((resolve) => setTimeout(resolve, 500))
        const page = await fetch(fwdBase + '/page.html', { headers: { origin: fwdBase } }).catch((e) => {
          console.log('转发器请求错误 ->', e.cause?.code ?? e.message)
          return null
        })
        assert(page !== null && page.status === 200, '转发器代理请求')
        const html = page === null ? '' : await page.text()
        assert(html.includes('crypto.randomUUID'), '转发器注入 randomUUID polyfill')
        assert(html.includes('<title>fake</title>'), '转发器保留原始 HTML 主体')
        const gate = await fetch(fwdBase + '/plugins/@deepseek-ai/dsh-client-connection/client.js?rev=abc', {
          headers: { origin: fwdBase },
        }).catch(() => null)
        assert(gate !== null && gate.status === 200, '转发器转发插件脚本')
        const gateJs = gate === null ? '' : await gate.text()
        assert(gateJs.includes('(true) ? "host"'), '转发器把回环门改写为 true')
        const probe = await fetch(fwdBase + '/hello', { headers: { origin: fwdBase } }).catch(() => null)
        assert(probe !== null && probe.status === 200, '转发器原样转发非 HTML 响应')
      }
    }
    await fetch(base2 + '/api/dsh/stop', { method: 'POST', headers: { cookie: cookie2 } })
    await app2.close()
    cleanup(app2.config.dataRoot)
  }

  r = await json('/api/dsh/stop', { method: 'POST', cookie })
  console.log('停止    ->', r.status)
  assert(r.status === 200, '停止成功')

  await new Promise((resolve) => setTimeout(resolve, 100))
  r = await json('/api/dsh/status', { cookie })
  assert(r.body.running === false, 'stop 后已停止')

  console.log('OK: DSH 启动/状态/子进程转发/停止流程通过')
} finally {
  await app.close()
  cleanup(dataRoot)
}
