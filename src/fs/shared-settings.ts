/**
 * 把管理员维护的共享 DSH 配置应用到用户隔离的 DSH 主目录。
 *
 * DSH 把模型提供商保存在 `<DSH_HOME>/settings.yaml` 的
 * `llm-pi-ai.providers` 命名空间下（route → profile，`apiKeyEnv` 指名一个
 * 凭据引用），凭据值保存在 `<DSH_HOME>/.credentials.yaml`
 * （ref → 原始 key）。运行中的 DSH 会监视这两份文档，因此外部写入
 * 无需重启即可热加载。这里的编辑都是叶子级的（只设置或删除共享的
 * route/ref），因此用户自己的提供商、凭据、注释和格式都会保留 ——
 * 使用的是 DSH 自己修补这些文件时所用的同一套 `yaml` Document API。
 * @module dsh-admin/fs/shared-settings
 */

import { randomBytes } from 'node:crypto'
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Document, parseDocument } from 'yaml'

/** 持久化在 `shared_config.payload` 列中的结构。 */
export interface SharedConfigPayload {
  providers: Record<string, Record<string, unknown>>
  credentials: Record<string, string>
}

/** 解析已存储的 payload JSON；providers+credentials 为空对象也是合法的。 */
export function parseSharedConfigPayload(text: string): SharedConfigPayload {
  const parsed = JSON.parse(text) as Partial<SharedConfigPayload>
  return {
    providers: parsed.providers ?? {},
    credentials: parsed.credentials ?? {},
  }
}

/** DSH（以及 YAML 路径）都能接受的 route 与凭据 ref 键。 */
const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/** 拒绝可能破坏 YAML 文档的 payload 键。 */
export function validateSharedConfigKeys(payload: SharedConfigPayload): string | null {
  for (const route of Object.keys(payload.providers)) {
    if (!KEY_RE.test(route)) return `无效的提供商 route：${JSON.stringify(route)}`
  }
  for (const ref of Object.keys(payload.credentials)) {
    if (!KEY_RE.test(ref)) return `无效的凭据 ref：${JSON.stringify(ref)}`
  }
  return null
}

/** 读取 YAML 文档；文件缺失时按空文档解析。 */
async function readDoc(file: string): Promise<Document> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Document({})
    throw error
  }
  const doc = parseDocument(text)
  if (doc.errors.length > 0) throw new Error(`位于 ${file} 的文档无法解析：${doc.errors[0]?.message}`)
  return doc
}

/** 序列化到临时文件、chmod 0600、再原子地 rename 覆盖目标文件。
 * 临时文件名带随机后缀，因此并发应用绝不会共享半截写入。 */
async function writeDocAtomic(file: string, doc: Document): Promise<void> {
  const tmp = `${file}.tmp-${process.pid.toString(36)}-${randomBytes(6).toString('hex')}`
  await writeFile(tmp, String(doc), { mode: 0o600 })
  await chmod(tmp, 0o600)
  await rename(tmp, file)
}

/** payload 一半（routes 或 refs）中被另一半丢弃的键。 */
function removedKeys(prev: Record<string, unknown> | undefined, next: Record<string, unknown>): Set<string> {
  return new Set(Object.keys(prev ?? {}).filter((key) => !(key in next)))
}

/**
 * 把共享配置合并进用户的 DSH 主目录。只触碰共享的 route/ref：
 * 存在于 `previous` 但不在 `next` 中的 route 会被移除
 * （管理员删除了它们），用户配置的其余内容一概不动。
 */
export async function applySharedConfig(homeDir: string, next: SharedConfigPayload, previous: SharedConfigPayload | null): Promise<void> {
  await mkdir(homeDir, { recursive: true })

  // 1. settings.yaml — llm-pi-ai.providers.<route>
  const settingsPath = join(homeDir, 'settings.yaml')
  const settings = await readDoc(settingsPath)
  for (const route of removedKeys(previous?.providers, next.providers)) {
    settings.deleteIn(['llm-pi-ai', 'providers', route])
  }
  for (const [route, profile] of Object.entries(next.providers)) {
    settings.setIn(['llm-pi-ai', 'providers', route], profile)
  }
  await writeDocAtomic(settingsPath, settings)

  // 2. .credentials.yaml — <ref> → 原始 key（在 settings 之后写入，这样
  // 中途重载的运行中 DSH 只会看到最终一致的一对文档）。
  const credentialsPath = join(homeDir, '.credentials.yaml')
  const credentials = await readDoc(credentialsPath)
  for (const ref of removedKeys(previous?.credentials, next.credentials)) {
    credentials.deleteIn([ref])
  }
  for (const [ref, value] of Object.entries(next.credentials)) {
    credentials.setIn([ref], value)
  }
  await writeDocAtomic(credentialsPath, credentials)
}
