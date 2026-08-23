#!/usr/bin/env node
/**
 * 独立编排器入口（`dsh-admin` 可执行程序）。
 *
 * 子命令：
 *   dsh-admin bootstrap-admin --username <u> --password <p>
 *   dsh-admin [服务器选项]
 * @module dsh-admin/cli
 */

import { randomUUID } from 'node:crypto'
import { parseArgs } from 'node:util'
import { parseCommandString, resolveConfig, type ConfigOverrides } from './config.js'
import { openDatabase } from './db/connection.js'
import { countAdmins, createUser } from './db/repo.js'
import { hashPassword } from './web/auth.js'
import { uidForUser } from './isolation.js'
import { buildServer } from './web/server.js'
import { ensureUserDir, userHomeDir } from './fs/workspace.js'

const HELP = `dsh-admin — DSH 服务器登录编排器

用法：
  dsh-admin [选项]                          启动服务器
  dsh-admin bootstrap-admin [选项]          创建首位管理员
  dsh-admin uid-for-user <userId>           查询用户对应的确定性 uid
                                            （账号级隔离建号用，见 docs/hard-isolation.md）

服务器选项：
  --port <n>        绑定端口（0 = 临时端口）。默认 3080。
  --host <h>        绑定主机。默认 127.0.0.1。
  --db <path>       SQLite 数据库路径。
  --data-root <p>   用户主目录与工作区的根目录。
  --dsh-bin <cmd>   拉起子 DSH 所用的命令。默认 "dsh"。
                    可包含参数，例如 'node C:/path/to/dsh/bin.js'
                    （路径含空格时请为整个值加引号）。
  --log-level <l>   Pino 日志级别。默认 "info"。
  --session-ttl <s> 会话有效期（秒）。默认 604800（7 天）。
  --isolation-mode <m> 隔离级别："soft" 或 "account"（Linux，需 root）。默认 "soft"。
  -h, --help        显示本帮助。

bootstrap-admin 选项：
  --username <u>    管理员用户名（必填）。
  --password <p>    管理员密码（或使用 DSH_ADMIN_ADMIN_PASSWORD 环境变量）。
  --db <path>       数据库路径。
  --data-root <p>   用户主目录的根目录。
`

interface ParsedValues {
  [key: string]: string | boolean | undefined
}

function toOverrides(values: ParsedValues): ConfigOverrides {
  const str = (value: string | boolean | undefined): string | undefined =>
    typeof value === 'string' ? value : undefined
  const dshBin = str(values['dsh-bin'])
  return {
    port: str(values.port),
    host: str(values.host),
    dbPath: str(values.db),
    dataRoot: str(values['data-root']),
    dshCommand: dshBin ? parseCommandString(dshBin) : undefined,
    logLevel: str(values['log-level']),
    sessionTtlSeconds: str(values['session-ttl']),
    maxUploadBytes: str(values['max-upload']),
    isolationMode: str(values['isolation-mode']),
  }
}

async function bootstrapAdmin(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      username: { type: 'string' },
      password: { type: 'string' },
      db: { type: 'string' },
      'data-root': { type: 'string' },
    },
  })
  const username = values.username
  const password = values.password ?? process.env.DSH_ADMIN_ADMIN_PASSWORD
  if (username === undefined || username === '' || password === undefined || password === '') {
    console.error('用法：dsh-admin bootstrap-admin --username <u> --password <p>')
    process.exit(2)
  }
  const config = resolveConfig({ dbPath: values.db, dataRoot: values['data-root'] })
  const db = openDatabase(config.dbPath)
  if (countAdmins(db) > 0) {
    console.error('管理员已存在；拒绝创建第二个管理员')
    db.close()
    process.exit(1)
  }
  const id = randomUUID()
  const homeDir = userHomeDir(config, id)
  await ensureUserDir(homeDir)
  const passHash = await hashPassword(password)
  createUser(db, { id, username, passHash, role: 'admin', homeDir })
  db.close()
  console.log(`管理员 "${username}" 已创建（id: ${id}）`)
}

async function runServer(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      port: { type: 'string' },
      host: { type: 'string' },
      db: { type: 'string' },
      'data-root': { type: 'string' },
      'dsh-bin': { type: 'string' },
      'log-level': { type: 'string' },
      'session-ttl': { type: 'string' },
      'max-upload': { type: 'string' },
      'isolation-mode': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  })

  if (values.help) {
    process.stdout.write(HELP)
    return
  }

  const config = resolveConfig(toOverrides(values as ParsedValues))
  const app = await buildServer(config)
  await app.listen({ host: config.host, port: config.port })

  const address = app.server.address()
  const actualPort = typeof address === 'object' && address !== null ? address.port : config.port
  app.log.info(`dsh-admin 监听地址 http://${config.host}:${actualPort}`)
  app.log.info(`数据根目录：${config.dataRoot}；数据库：${config.dbPath}`)

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info(`收到信号 ${signal}，正在关闭`)
    await app.close()
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
}

function uidForUserCmd(args: string[]): void {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { 'base-uid': { type: 'string' } },
  })
  const userId = positionals[0]
  if (userId === undefined) {
    console.error('用法：dsh-admin uid-for-user <userId> [--base-uid N]')
    process.exit(2)
  }
  const baseUid = Number(values['base-uid'] ?? process.env.DSH_ADMIN_BASE_UID ?? 100000)
  console.log(uidForUser(userId, baseUid))
}

async function main(): Promise<void> {
  const [first, ...rest] = process.argv.slice(2)
  if (first === 'bootstrap-admin') {
    await bootstrapAdmin(rest)
    return
  }
  if (first === 'uid-for-user') {
    uidForUserCmd(rest)
    return
  }
  await runServer(process.argv.slice(2))
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
