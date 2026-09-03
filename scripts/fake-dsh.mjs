// 冒烟测试用的 `dsh` 真实进程替身。通过 DSH_ADMIN_ROLE 区分角色：
//   - main：绑定回环端口并提供标记页；首页模拟 dsh ≥0.1.2-alpha.5 的
//     launchToken 认证门（?token= 交换 → 303 种 cookie，否则 401），
//     `dsh web: …` 行在监听后延迟 500ms 才打印（复现竞态窗口）。
//     /crash 时以退出码 1 退出。
//   - watchdog：无头；轮询交接文件并记录它“执行”的内容。
import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const role = process.env.DSH_ADMIN_ROLE ?? 'main'
const port = Number(process.env.DSH_ADMIN_PORT ?? '3080')
const cwd = process.cwd()

// 版本探测（编排器 dshVersion()）：打印标记行即退，不绑定端口。
if (process.argv.includes('--version')) {
  console.log('fake-dsh 9.9.9-smoke')
  process.exit(0)
}

if (role === 'watchdog') {
  // 一次性看门狗：标记已运行，执行交接命令，然后退出。
  const handoffPath = process.env.DSH_ADMIN_HANDOFF_PATH
  console.log(`fake-watchdog 一次性运行中 cwd=${cwd}`)
  if (handoffPath !== undefined) {
    writeFileSync(join(dirname(handoffPath), 'watchdog-ran.json'), JSON.stringify({ at: Date.now() }))
  }
  setTimeout(() => {
    let command = null
    if (handoffPath !== undefined && existsSync(handoffPath)) {
      const content = readFileSync(handoffPath, 'utf8').trim()
      if (content !== '') {
        try {
          command = JSON.parse(content).command ?? content
        } catch {
          command = content
        }
        writeFileSync(join(dirname(handoffPath), 'watchdog-executed.json'), JSON.stringify({ command, at: Date.now() }))
        writeFileSync(handoffPath, '')
      }
    }
    console.log(`fake-watchdog 完成${command ? `（已执行：${command}）` : ''}`)
    process.exit(0)
  }, 300)
} else {
  // 模拟 dsh ≥0.1.2-alpha.5 的 web 首页认证门：进程内随机 launchToken，
  // 首页只接受 ?token= 交换（303 到干净 / 并种会话 cookie）或有效
  // cookie；无凭据一律 401（真实 dsh 的同款提示文案）。
  const launchToken = randomBytes(32).toString('base64url')
  const authCookie = 'dsh-auth-fake=ok'
  const unauthorized = (res) => {
    res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('dsh web authentication required; reopen the URL printed by dsh web.\n')
  }
  const server = createServer((req, res) => {
    if (req.url === '/crash') {
      res.writeHead(500, { 'content-type': 'text/plain' })
      res.end('crashing')
      setTimeout(() => process.exit(1), 10)
      return
    }
    if (req.url === '/redirect') {
      res.writeHead(302, { location: '/somewhere' })
      res.end('redirecting')
      return
    }
    if (req.url === '/page.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end('<!doctype html><html><head><title>fake</title></head><body>ok</body></html>')
      return
    }
    if ((req.url ?? '').split('?')[0] === '/plugins/@deepseek-ai/dsh-client-connection/client.js') {
      res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8' })
      res.end('const gate = isLoopbackHostname(pageLocation.hostname) ? "host" : "memory"')
      return
    }
    // 模拟 dsh ≥0.1.2-alpha.5 的组合端点：整批脚本 `/plugins/??<id>/client.js,…`，
    // 环回门内嵌在合并体里（转发器也必须改写这条路径）。
    if ((req.url ?? '').startsWith('/plugins/??')) {
      res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8' })
      res.end(
        '/* other-plugin */\n' +
          'const gate = isLoopbackHostname(pageLocation.hostname) ? "host" : "memory"\n',
      )
      return
    }
    const url = new URL(req.url ?? '/', 'http://x')
    if (url.pathname === '/') {
      const tokens = url.searchParams.getAll('token')
      if (tokens.length > 0) {
        if (req.method === 'GET' && tokens.length === 1 && tokens[0] === launchToken) {
          res.writeHead(303, { location: '/', 'set-cookie': `${authCookie}; Path=/` })
          res.end()
          return
        }
        unauthorized(res)
        return
      }
      const cookies = (req.headers.cookie ?? '').split(';').map((c) => c.trim())
      if (cookies.includes(authCookie)) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end('<!doctype html><html><head><title>fake-dsh-web</title></head><body>authenticated</body></html>')
        return
      }
      unauthorized(res)
      return
    }
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end(
      `fake-dsh pid=${process.pid} port=${port} cwd=${cwd} url=${req.url} argv=${process.argv.slice(2).join(' ')}`,
    )
  })
  server.listen(port, '127.0.0.1', () => {
    console.log(`fake-dsh 已监听端口 ${port}`)
    // 真实 dsh 在插件加载完成后才打印 URL —— 延迟打印以复现
    // "端口已就绪、令牌未打印"的竞态窗口。
    setTimeout(() => {
      console.log(`dsh web: http://127.0.0.1:${port}/?token=${launchToken}`)
    }, 500)
  })
}
