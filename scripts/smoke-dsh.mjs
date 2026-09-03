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
  assert(r.body.dshVersion === 'fake-dsh 9.9.9-smoke', 'status 附带 dsh CLI 版本行')

  r = await json('/api/dsh/launch', { method: 'POST', cookie, body: { folder: 'proj' } })
  console.log('启动    ->', r.status, r.body)
  assert(r.status === 200 && typeof r.body.url === 'string', '启动成功')
  const childPort = r.body.instance.port
  // 回环模式：url 需等子 DSH 打印它的首页认证令牌（fake-dsh 延迟 500ms
  // 才打印）才就绪 —— 轮询直到 running 且 url 携带 ?token=。
  for (let i = 0; i < 100; i++) {
    r = await json('/api/dsh/status', { cookie })
    if (r.body.running === true && r.body.url !== '') break
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  console.log('状态    ->', r.status, r.body)
  assert(r.body.running === true, '启动后处于运行状态（端口就绪后）')
  const url = r.body.url
  // dev 服务绑定回环端口 → url 直连子进程端口并携带 DSH 自己的首页令牌。
  assert(
    url.startsWith(`http://127.0.0.1:${childPort}/?token=`),
    'dev url 是子进程端口且携带 DSH 首页令牌',
  )

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
    console.log('内网    ->', res2.status, '端口', body2.instance.port)
    assert(
      res2.status === 200 && body2.url.startsWith(`http://192.168.1.100:${body2.instance.port}/?dsh_token=`),
      'publicHost 的 url 携带访问令牌',
    )
    const fwdToken = body2.url.split('?dsh_token=')[1]
    assert(fwdToken !== undefined && fwdToken.length >= 32, '令牌为足够长的随机串')
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
        // DSH web 首页令牌交接（dsh ≥0.1.2-alpha.5 的浏览器认证门）：
        // 携带 dsh_token 的首导航被转发器改写为携带子 DSH 的
        // launchToken → DSH 以 303 种下自己的会话 cookie。fake-dsh 在
        // 监听后 500ms 才打印令牌，竞态窗口内转发器返回自动重试页。
        {
          let exchange = null
          let sawRetry = false
          for (let i = 0; i < 60; i++) {
            const res = await fetch(fwdBase + `/?dsh_token=${fwdToken}`, { redirect: 'manual' }).catch(() => null)
            if (res !== null && res.status === 303) {
              exchange = res
              break
            }
            if (res !== null && res.status === 503) {
              sawRetry = true
              const html = await res.text()
              assert(html.includes('http-equiv="refresh"'), '竞态窗口返回自动重试页')
            }
            await new Promise((resolve) => setTimeout(resolve, 200))
          }
          console.log('令牌交接 ->', exchange === null ? '失败' : `${exchange.status}（重试页${sawRetry ? '已出现' : '未触发'}）`)
          assert(sawRetry, '令牌就绪前首导航拿到自动重试页而非 401')
          assert(exchange !== null, '首导航被交接为 DSH 的 token 交换（303）')
          assert(exchange.headers.get('location') === '/', 'token 交换重定向到干净根路径')
          const setCookies = exchange.headers.getSetCookie()
          assert(setCookies.some((c) => c.startsWith('dsh-auth-')), 'token 交换种下 DSH 会话 cookie')
          assert(setCookies.some((c) => c.startsWith('dshfwd=')), '同一响应种下转发器访问 cookie')
          // 双 cookie 访问干净根路径 → DSH 放行首页。
          const cookiePair = setCookies.map((c) => c.split(';')[0]).join('; ')
          const home = await fetch(fwdBase + '/', { headers: { cookie: cookiePair } }).catch(() => null)
          assert(home !== null && home.status === 200, '交接后的 cookie 可访问 DSH 首页')
          const homeText = home === null ? '' : await home.text()
          assert(homeText.includes('authenticated'), 'DSH 首页内容正常返回')
          // 只有转发器 cookie、没有 DSH 会话 cookie 的首页仍被 401 ——
          // 门在子 DSH 侧，转发器不替它放行。
          const fwdOnly = (setCookies.find((c) => c.startsWith('dshfwd=')) ?? '').split(';')[0]
          const bareHome = await fetch(fwdBase + '/', { headers: { cookie: fwdOnly } }).catch(() => null)
          assert(bareHome !== null && bareHome.status === 401, '无 DSH 会话 cookie 的首页仍被 401')
        }
        // 转发器在启动后异步绑定；稍等片刻。
        await new Promise((resolve) => setTimeout(resolve, 500))
        // 无令牌的请求必须被拒绝（内网直连不能绕过登录）。
        const bare = await fetch(fwdBase + '/hello', { headers: { origin: fwdBase } }).catch(() => null)
        assert(bare !== null && bare.status === 401, '无令牌的转发器请求被 401 拒绝')
        const wrong = await fetch(fwdBase + '/hello?dsh_token=bogus', { headers: { origin: fwdBase } }).catch(() => null)
        assert(wrong !== null && wrong.status === 401, '错误令牌的转发器请求被 401 拒绝')
        const page = await fetch(fwdBase + `/page.html?dsh_token=${fwdToken}`, { headers: { origin: fwdBase } }).catch((e) => {
          console.log('转发器请求错误 ->', e.cause?.code ?? e.message)
          return null
        })
        assert(page !== null && page.status === 200, '转发器代理携带令牌的请求')
        assert((page.headers.get('set-cookie') ?? '').startsWith('dshfwd='), '令牌导航种下 dshfwd cookie')
        const html = page === null ? '' : await page.text()
        assert(html.includes('crypto.randomUUID'), '转发器注入 randomUUID polyfill')
        assert(html.includes('<title>fake</title>'), '转发器保留原始 HTML 主体')
        const cookieFwd = (page.headers.get('set-cookie') ?? '').split(';')[0]
        const viaCookie = await fetch(fwdBase + '/hello', { headers: { origin: fwdBase, cookie: cookieFwd } }).catch(() => null)
        assert(viaCookie !== null && viaCookie.status === 200, 'cookie 可通过后续请求校验')
        const gate = await fetch(fwdBase + `/plugins/@deepseek-ai/dsh-client-connection/client.js?rev=abc&dsh_token=${fwdToken}`, {
          headers: { origin: fwdBase },
        }).catch(() => null)
        assert(gate !== null && gate.status === 200, '转发器转发插件脚本')
        const gateJs = gate === null ? '' : await gate.text()
        assert(gateJs.includes('(true) ? "host"'), '转发器把回环门改写为 true')
        // 组合端点（dsh ≥0.1.2-alpha.5）：整批脚本 /plugins/??<id>/client.js,…
        // 环回门内嵌合并体，同样必须被改写。
        const combo = await fetch(
          fwdBase + `/plugins/??@deepseek-ai/dsh-client-ui-settings/client.js,@deepseek-ai/dsh-client-connection/client.js&rev=abc&dsh_token=${fwdToken}`,
          { headers: { origin: fwdBase } },
        ).catch(() => null)
        assert(combo !== null && combo.status === 200, '转发器转发组合端点脚本')
        const comboJs = combo === null ? '' : await combo.text()
        assert(comboJs.includes('other-plugin'), '组合端点返回合并体')
        assert(comboJs.includes('(true) ? "host"'), '组合端点的回环门同样被改写为 true')
        const probe = await fetch(fwdBase + `/hello?dsh_token=${fwdToken}`, { headers: { origin: fwdBase } }).catch(() => null)
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
