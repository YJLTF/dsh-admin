/**
 * 内网模式的每子进程转发器：一个进程内 HTTP/WebSocket 反向代理，
 * 监听可发布网卡（eth0）并转发到子 DSH 的环回监听。
 *
 * 为什么不用纯 TCP（socat）：内网部署从 `http://<lan-ip>:<port>` 提供
 * DSH SPA —— 这是不安全上下文，`crypto.randomUUID` 在其中为 undefined
 * （DSH 客户端插件用它生成 RPC id，会直接崩溃），而且 DSH 的信任栅栏
 * 会对任何携带浏览器 Origin 的请求返回 403。本代理剥除 Origin，并向
 * HTML 响应注入 randomUUID 垫片。
 * @module dsh-admin/supervisor/forwarder
 */

import type { IncomingHttpHeaders, Server as HttpServer } from 'node:http'
import { createServer, request as httpRequest } from 'node:http'
import { connect, type Socket } from 'node:net'
import { Agent } from 'node:http'

const agent = new Agent({ keepAlive: true, maxSockets: 16 })

/** 浏览器信任栅栏：被代理的请求不得携带的头。 */
const STRIP_HEADERS = new Set([
  'origin',
  'referer',
  'sec-fetch-site',
  'sec-fetch-mode',
  'sec-fetch-dest',
  'sec-fetch-user',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
])

/**
 * 面向不安全内网源（`http://<lan-ip>`）的文档起始垫片：
 * 通过 getRandomValues（在不安全上下文中可用）实现的
 * `crypto.randomUUID` 垫片 —— DSH 客户端插件用它生成 RPC id。
 */
const SHIM =
  '<script>(function(){' +
  "if(typeof crypto.randomUUID!=='function'){crypto.randomUUID=function(){var b=crypto.getRandomValues(new Uint8Array(16));" +
  'b[6]=b[6]&0x0f|0x40;b[8]=b[8]&0x3f|0x80;' +
  "var h=Array.from(b,function(x){return x.toString(16).padStart(2,'0')}).join('');" +
  "return h.slice(0,8)+'-'+h.slice(8,12)+'-'+h.slice(12,16)+'-'+h.slice(16,20)+'-'+h.slice(20)}};" +
  '})()</script>'

/**
 * DSH 把它的设置功能限制在页面源为环回的情况（"设置 RPC 仅限环回"）：
 * `isLoopbackHostname(pageLocation.hostname)`。浏览器保证
 * `location.hostname` 不可伪造，因此这个门被改写在连接插件的脚本里。
 * 转发器本身就是环回路径（浏览器 → 转发器 → 127.0.0.1 上的子进程），
 * 所以该门的网络不变量仍然成立；只有页面源检查会错误地为局域网 IP
 * 访客禁用设置。
 */
const LOOPBACK_GATE_RE = /isLoopbackHostname\(pageLocation\.hostname\)/g

/** 客户端代码携带环回门的那个插件的路径前缀。 */
const CONNECTION_PLUGIN_PREFIX = '/plugins/@deepseek-ai/dsh-client-connection/'

function isConnectionClient(url: string | undefined): boolean {
  const path = (url ?? '').split('?')[0]
  return path.startsWith(CONNECTION_PLUGIN_PREFIX) && path.endsWith('.js')
}

function patchConnectionClient(js: string): string {
  return js.replace(LOOPBACK_GATE_RE, '(true)')
}

/** 把垫片插到 <head> 之后（doctype 之前的节点会让文档落入怪异模式）；
 * 不存在 head 标签时则前置于开头。 */
export function injectScript(html: string, script: string): string {
  const headAt = html.search(/<head[^>]*>/i)
  if (headAt === -1) return script + html
  const insertAt = html.indexOf('>', headAt)
  if (insertAt === -1) return script + html
  return html.slice(0, insertAt + 1) + script + html.slice(insertAt + 1)
}

function buildUpstreamHeaders(headers: IncomingHttpHeaders, port: number): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {}
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined || STRIP_HEADERS.has(key.toLowerCase())) continue
    out[key] = value as string | string[]
  }
  // 仅标识编码（identity），这样下面的 HTML 注入才能改写响应体。
  delete out['accept-encoding']
  out.host = `127.0.0.1:${port}`
  return out
}

function relayUpgrade(req: import('node:http').IncomingMessage, socket: import('node:stream').Duplex, head: Buffer, port: number): void {
  const upstream = connect({ host: '127.0.0.1', port })
  upstream.on('connect', () => {
    const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`]
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const name = (req.rawHeaders[i] ?? '').toLowerCase()
      if (name === 'host' || STRIP_HEADERS.has(name)) continue
      lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`)
    }
    lines.push(`Host: 127.0.0.1:${port}`)
    upstream.write(lines.join('\r\n') + '\r\n\r\n')
    if (head.length > 0) upstream.write(head)
    socket.pipe(upstream)
    upstream.pipe(socket)
  })
  upstream.on('error', () => socket.destroy())
  socket.on('error', () => upstream.destroy())
}

/**
 * 为一个子 DSH 启动转发器。监听绑定完成后 resolve。
 */
export function startForwarder(lanIp: string, port: number): Promise<HttpServer> {
  const server = createServer((req, res) => {
    const upstream = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path: req.url,
        method: req.method,
        agent,
        headers: buildUpstreamHeaders(req.headers, port),
      },
      (upRes) => {
        const headers = { ...upRes.headers }
        const contentType = String(headers['content-type'] ?? '')
        const isHtml = contentType.includes('text/html')
        const rewriteJs = contentType.includes('javascript') && isConnectionClient(req.url)
        const noBody = (upRes.statusCode ?? 200) === 204 || (upRes.statusCode ?? 200) === 304
        if ((isHtml || rewriteJs) && !noBody) {
          delete headers['content-length'] // 响应体会在下方被改写
          const chunks: Buffer[] = []
          upRes.on('data', (c: Buffer) => chunks.push(c))
          upRes.on('error', () => res.destroy()) // 传输中途上游失败
          upRes.on('end', () => {
            const body = Buffer.concat(chunks).toString('utf-8')
            const out = isHtml ? injectScript(body, SHIM) : patchConnectionClient(body)
            res.writeHead(upRes.statusCode ?? 502, headers)
            res.end(out)
          })
          return
        }
        res.writeHead(upRes.statusCode ?? 502, headers)
        upRes.pipe(res)
      },
    )
    upstream.on('error', () => res.destroy())
    req.pipe(upstream)
  })
  server.on('upgrade', (req, socket, head) => relayUpgrade(req, socket, head, port))
  return new Promise((resolve, reject) => {
    const onError = (err: Error) => {
      // 运行期的监听错误绝不能调用已结算的 reject。
      process.stderr.write(`[dsh-forwarder :${port}] ${String(err)}\n`)
    }
    server.once('error', reject)
    server.listen(port, lanIp, () => {
      server.removeListener('error', reject)
      server.on('error', onError)
      resolve(server)
    })
  })
}
