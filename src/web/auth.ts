/**
 * 密码哈希、会话令牌辅助函数与 cookie 组装。
 *
 * 使用 `node:crypto` 的 scrypt，使脚手架除 SQLite 外零原生依赖；
 * 生产环境可以不改调用点直接换成 argon2id。
 * @module dsh-admin/web/auth
 */

import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'

const scryptAsync = promisify(scrypt) as (password: string, salt: Buffer, keylen: number) => Promise<Buffer>

const KEY_LENGTH = 64

/** 把密码哈希为 `scrypt$<salt>$<hash>` 字符串。 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16)
  const derived = await scryptAsync(password, salt, KEY_LENGTH)
  return `scrypt$${salt.toString('hex')}$${derived.toString('hex')}`
}

/** 与已存储的 `scrypt$...` 字符串做常数时间密码校验。 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, saltHex, hashHex] = stored.split('$')
  if (scheme !== 'scrypt' || saltHex === undefined || hashHex === undefined) return false
  const expected = Buffer.from(hashHex, 'hex')
  const derived = await scryptAsync(password, Buffer.from(saltHex, 'hex'), KEY_LENGTH)
  return derived.length === expected.length && timingSafeEqual(derived, expected)
}

/** 生成一个全新的不透明会话令牌。 */
export function newSessionToken(): string {
  return randomBytes(32).toString('base64url')
}

/** 哈希会话令牌以供存储；数据库绝不保存原始令牌。 */
export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/** 从 `Cookie` 头中提取指定名称的 cookie 值。 */
export function parseCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined
  for (const part of header.split(';')) {
    const idx = part.indexOf('=')
    if (idx === -1) continue
    if (part.slice(0, idx).trim() === name) return part.slice(idx + 1).trim()
  }
  return undefined
}

/** 为会话令牌构造 `Set-Cookie` 值。仅限当前主机：单源内网部署下
 * cookie 永远不需要跨主机。 */
export function sessionCookie(token: string, maxAgeSeconds: number): string {
  return ['sid=' + token, 'HttpOnly', 'SameSite=Lax', 'Path=/', `Max-Age=${maxAgeSeconds}`].join('; ')
}

/** 构造使会话 cookie 过期的 `Set-Cookie` 值。 */
export function clearSessionCookie(): string {
  return ['sid=', 'HttpOnly', 'SameSite=Lax', 'Path=/', 'Max-Age=0'].join('; ')
}
