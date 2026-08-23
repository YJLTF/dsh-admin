// 冒烟测试用的 `dsh` 真实进程替身。通过 DSH_ADMIN_ROLE 区分角色：
//   - main：绑定回环端口并提供标记页；/crash 时以退出码 1 退出。
//   - watchdog：无头；轮询交接文件并记录它“执行”的内容。
import { createServer } from 'node:http'
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
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end(
      `fake-dsh pid=${process.pid} port=${port} cwd=${cwd} url=${req.url} argv=${process.argv.slice(2).join(' ')}`,
    )
  })
  server.listen(port, '127.0.0.1', () => {
    console.log(`fake-dsh 已监听端口 ${port}`)
  })
}
