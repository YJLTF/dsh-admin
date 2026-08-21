// 账号级隔离 spawn 流程：'account' 模式下编排器把确定性 uid 传给 setuid 包装器，
// 子进程仍然经由它运行。
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildServer } from '../lib/web/server.js'
import { resolveConfig } from '../lib/config.js'
import { uidForUser } from '../lib/isolation.js'
import { createUser } from '../lib/db/repo.js'
import { hashPassword } from '../lib/web/auth.js'
import { assert, makeJson, sleep } from './helpers.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const fakeDsh = join(here, 'fake-dsh.mjs')
const fakeSetpriv = join(here, 'fake-setpriv.mjs')
const dataRoot = mkdtempSync(join(tmpdir(), 'dsh-smoke-iso-'))

const app = await buildServer(
  resolveConfig({
    port: 0,
    dbPath: ':memory:',
    dataRoot,
    isolationMode: 'account',
    baseUid: 50000,
    spawnAsUserCommand: [process.execPath, fakeSetpriv, '--uid', '{UID}'],
    dshCommand: [process.execPath, fakeDsh],
  }),
)
await app.listen({ port: 0 })
const base = `http://127.0.0.1:${app.server.address().port}`

createUser(app.db, {
  id: 'u1',
  username: 'gina',
  passHash: await hashPassword('ginapass123'),
  role: 'active',
  homeDir: '/tmp/u1-home',
})
mkdirSync(join(dataRoot, 'users', 'u1', 'ws', 'proj'), { recursive: true })

const json = makeJson(base)


try {
  let r = await json('/api/auth/login', { method: 'POST', body: { username: 'gina', password: 'ginapass123' } })
  const cookie = r.setCookie.split(';')[0]

  r = await json('/api/dsh/launch', { method: 'POST', cookie, body: { folder: 'proj' } })
  console.log('启动     ->', r.status)
  assert(r.status === 200, '启动成功')
  const childPort = r.body.instance.port

  let uid
  for (let i = 0; i < 20; i++) {
    try {
      uid = readFileSync(join(dataRoot, 'users', 'u1', 'ws', 'proj', 'setpriv-uid.txt'), 'utf8').trim()
      break
    } catch {
      // 包装器还没写入
    }
    await sleep(100)
  }
  const expected = uidForUser('u1', 50000)
  console.log('setuid   ->', uid, '（预期', expected + '）')
  assert(uid === String(expected), 'setuid 包装器收到了确定性 uid')

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
    await sleep(100)
  }
  console.log('子进程   ->', childText !== undefined)
  assert(childText !== undefined && childText.includes('fake-dsh'), 'dsh 经由 setuid 包装器运行')

  console.log('OK: 账号级隔离 spawn 流程通过')
} finally {
  await app.close()
  await sleep(300)
  try {
    rmSync(dataRoot, { recursive: true, force: true })
  } catch {
    // 尽力而为的清理
  }
}
