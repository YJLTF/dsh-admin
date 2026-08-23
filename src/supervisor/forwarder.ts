/**
 * 内网模式的每子进程转发器：一个进程内 HTTP/WebSocket 反向代理，
 * 监听可发布网卡（eth0）并转发到子 DSH 的环回监听。
 *
 * 为什么不用纯 TCP（socat）：内网部署从 `http://<lan-ip>:<port>` 提供
 * DSH SPA —— 这是不安全上下文，`crypto.randomUUID` 在其中为 undefined
 * （DSH 客户端插件用它生成 RPC id，会直接崩溃），而且 DSH 的信任栅栏
 * 会对任何携带浏览器 Origin 的请求返回 403。本代理剥除 Origin，并向
 * HTML 响应注入 randomUUID 垫片。
 *
 * 访问令牌：已发布的端口在内网上对任何主机可达，因此每个实例持有
 * 一个随机令牌 —— 没有它（首次导航携带 `?dsh_token=`，之后是
 * `dshfwd` cookie，WS 升级同样校验）的请求一律 401。这把"谁能用
 * 这个 DSH"重新关回 dsh-admin 的登录/授权门后。
 * @module dsh-admin/supervisor/forwarder
 */

import type { IncomingHttpHeaders, Server as HttpServer } from 'node:http'
import { createServer, request as httpRequest } from 'node:http'
import { connect, type Socket } from 'node:net'
import { createHash, timingSafeEqual } from 'node:crypto'
import { Agent } from 'node:http'

const agent = new Agent({ keepAlive: true, maxSockets: 16 })

/** 首次导航携带令牌的查询参数名（也在代理前被剥除，不外泄给上游）。 */
const TOKEN_QUERY = 'dsh_token'
/** 校验通过后颁发给浏览器的 cookie 名（HttpOnly；随实例令牌轮换）。 */
const TOKEN_COOKIE = 'dshfwd'

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

/** 常数时间令牌比较（先哈希以对齐长度，不泄漏比较耗时或长度信息）。 */
function tokenEquals(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest()
  const hb = createHash('sha256').update(b).digest()
  return timingSafeEqual(ha, hb)
}

/** 从请求 URL 的查询串中提取 `dsh_token`（base64url 值不含 '='，无需解码）。 */
function queryToken(url: string | undefined): string | undefined {
  const query = (url ?? '').split('?')[1]
  if (query === undefined) return undefined
  for (const pair of query.split('&')) {
    const eq = pair.indexOf('=')
    if (eq !== -1 && pair.slice(0, eq) === TOKEN_QUERY) return pair.slice(eq + 1)
  }
  return undefined
}

/** 从代理 URL 中剥除令牌查询参数（保留其余参数）。 */
function stripTokenParam(url: string): string {
  const qi = url.indexOf('?')
  if (qi === -1) return url
  const kept = url
    .slice(qi + 1)
    .split('&')
    .filter((pair) => pair.split('=')[0] !== TOKEN_QUERY)
    .join('&')
  return kept === '' ? url.slice(0, qi) : `${url.slice(0, qi + 1)}${kept}`
}

interface TokenCheck {
  ok: boolean
  /** 通过查询参数验证通过 —— 响应应同时种下 cookie。 */
  viaQuery: boolean
}

/** 校验请求的令牌：查询参数（首次导航）或 cookie（后续请求/WS 升级）。
 * 查询参数过期（例如重启后的旧书签）时回退 cookie，两者皆无/皆错才拒绝。 */
function checkToken(req: import('node:http').IncomingMessage, token: string): TokenCheck {
  const q = queryToken(req.url)
  if (q !== undefined && tokenEquals(q, token)) return { ok: true, viaQuery: true }
  const cookie = parseCookieValue(req.headers.cookie, TOKEN_COOKIE)
  if (cookie !== undefined && tokenEquals(cookie, token)) return { ok: true, viaQuery: false }
  return { ok: false, viaQuery: false }
}

/** 从 `Cookie` 头中提取指定名称的值（与 web/auth 的 parseCookie 同构，
 * 但转发器不依赖 Fastify 层，这里内联一份最小实现）。 */
function parseCookieValue(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined
  for (const part of header.split(';')) {
    const idx = part.indexOf('=')
    if (idx !== -1 && part.slice(0, idx).trim() === name) return part.slice(idx + 1).trim()
  }
  return undefined
}

/** 种下转发器 cookie（HttpOnly；不设 Max-Age —— 浏览器会话级即可，
 * 实例重启会轮换令牌并使旧 cookie 失效）。 */
function tokenCookie(token: string): string {
  return `${TOKEN_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/`
}

function relayUpgrade(req: import('node:http').IncomingMessage, socket: import('node:stream').Duplex, head: Buffer, port: number, token: string): void {
  if (!checkToken(req, token).ok) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
    socket.destroy()
    return
  }
  const upstream = connect({ host: '127.0.0.1', port })
  upstream.on('connect', () => {
    const path = stripTokenParam(req.url ?? '/')
    const lines = [`${req.method} ${path} HTTP/${req.httpVersion}`]
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
  // 半关闭/异常断开不一定伴随 error 事件；两侧 close 互相兜底，
  // 否则存活一侧的 fd 会一直挂到对端超时。
  socket.on('close', () => upstream.destroy())
  upstream.on('close', () => socket.destroy())
}

/**
 * 为一个子 DSH 启动转发器。监听绑定完成后 resolve。
 * 所有请求（HTTP 与 WS 升级）必须携带 `token` —— 查询参数或 cookie。
 */
export function startForwarder(lanIp: string, port: number, token: string): Promise<HttpServer> {
  const server = createServer((req, res) => {
    const check = checkToken(req, token)
    if (!check.ok) {
      res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('unauthorized')
      return
    }
    // 首次导航（令牌在查询串中）：种 cookie 供后续请求与 WS 升级使用，
    // 并把令牌从代理路径中剥除（不外泄给上游 DSH）。
    const extraHeaders = check.viaQuery ? { 'set-cookie': tokenCookie(token) } : {}
    const path = stripTokenParam(req.url ?? '/')
    const upstream = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path,
        method: req.method,
        agent,
        headers: buildUpstreamHeaders(req.headers, port),
      },
      (upRes) => {
        const headers = { ...upRes.headers, ...extraHeaders }
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
    // 客户端中途断开（响应未写完就 close）：销毁上游请求，
    // 避免向已销毁的响应继续写入以及连接空转；响应自身的
    // 流错误（如 DESTROY 后写入）也不允许冒泡成未处理异常。
    res.on('error', () => upstream.destroy())
    res.on('close', () => {
      if (!res.writableEnded) upstream.destroy()
    })
    req.pipe(upstream)
  })
  server.on('upgrade', (req, socket, head) => relayUpgrade(req, socket, head, port, token))
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
