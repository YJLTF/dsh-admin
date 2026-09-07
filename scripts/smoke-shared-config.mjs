/**
 * 共享配置合并冒烟测试（无需起服务器）：
 *   settings.yaml 路由合并/删除同步（用户自有内容保留）→
 *   .credentials.yaml refs 命名空间合并 → 历史版本顶层残留键清理 →
 *   删除同步 → 全新文件补 version → 键名校验 → payload 解析容错。
 *
 * 运行：npm run build && npm run smoke:shared-config
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseDocument } from 'yaml'

const { applySharedConfig, validateSharedConfigKeys, parseSharedConfigPayload } = await import('../lib/fs/shared-settings.js')

let passed = 0

function ok(cond, name) {
  if (!cond) {
    console.error(`  ✗ ${name}`)
    process.exitCode = 1
    throw new Error(`断言失败：${name}`)
  }
  passed++
  console.log(`  ✓ ${name}`)
}

const root = await mkdtemp(join(tmpdir(), 'dsh-smoke-shared-'))

try {
  // ---------- 1. credentials：refs 命名空间合并 + 顶层残留清理 ----------
  console.log('\n[1] .credentials.yaml 合并（refs 命名空间）')
  const homeA = join(root, 'home-a')
  await mkdir(homeA, { recursive: true })
  // dsh 自建形态的文件 + 旧版平台（把 ref 写在顶层）留下的残留。
  await writeFile(
    join(homeA, '.credentials.yaml'),
    [
      'version: 1',
      'refs:',
      '  SHARED_OLD: sk-old',
      'records:',
      '  client-connection/browser-session:',
      '    kind: grant',
      '    payload:',
      '      version: 1',
      '      secret: keep-me',
      'SHARED_TOPLEVEL: sk-toplevel',
      '',
    ].join('\n'),
  )
  await applySharedConfig(
    homeA,
    { providers: {}, credentials: { SHARED_NEW: 'sk-new' } },
    { providers: {}, credentials: { SHARED_OLD: 'sk-old', SHARED_TOPLEVEL: 'sk-toplevel' } },
  )
  const doc = parseDocument(await readFile(join(homeA, '.credentials.yaml'), 'utf8'))
  const topKeys = Object.keys(doc.toJS())
  ok(topKeys.every((k) => ['version', 'refs', 'records'].includes(k)), `顶层只含 version/refs/records（实际 ${topKeys.join(', ')}）`)
  ok(doc.getIn(['refs', 'SHARED_NEW']) === 'sk-new', '新 ref 写入 refs 命名空间')
  ok(doc.getIn(['refs', 'SHARED_OLD']) === undefined, '被删除的 ref 从 refs 同步撤掉')
  ok(doc.get('version') === 1, '已有 version 保留')
  ok(doc.has('records') && String(doc).includes('keep-me'), 'records（dsh 自有数据）原样保留')

  // ---------- 2. settings.yaml：路由合并与用户内容保留 ----------
  console.log('\n[2] settings.yaml 路由合并')
  const homeB = join(root, 'home-b')
  await mkdir(homeB, { recursive: true })
  await writeFile(
    join(homeB, 'settings.yaml'),
    [
      '# 用户自己的注释',
      'llm-pi-ai:',
      '  providers:',
      '    mine:',
      '      apiKeyEnv: MY_OWN_KEY',
      '',
    ].join('\n'),
  )
  await applySharedConfig(
    homeB,
    { providers: { deepseek: { apiKeyEnv: 'SHARED_DEEPSEEK', baseURL: 'https://api.deepseek.com' } }, credentials: {} },
    { providers: {}, credentials: {} },
  )
  const settings = parseDocument(await readFile(join(homeB, 'settings.yaml'), 'utf8'))
  ok(settings.getIn(['llm-pi-ai', 'providers', 'deepseek', 'apiKeyEnv']) === 'SHARED_DEEPSEEK', '共享路由写入 llm-pi-ai.providers')
  ok(settings.getIn(['llm-pi-ai', 'providers', 'mine', 'apiKeyEnv']) === 'MY_OWN_KEY', '用户自有路由保留')
  ok(String(settings).includes('# 用户自己的注释'), '用户注释保留')
  await applySharedConfig(
    homeB,
    { providers: {}, credentials: {} },
    { providers: { deepseek: { apiKeyEnv: 'SHARED_DEEPSEEK', baseURL: 'https://api.deepseek.com' } }, credentials: {} },
  )
  const settingsAfter = parseDocument(await readFile(join(homeB, 'settings.yaml'), 'utf8'))
  ok(settingsAfter.getIn(['llm-pi-ai', 'providers', 'deepseek']) === undefined, '管理员删除的路由同步撤掉')
  ok(settingsAfter.getIn(['llm-pi-ai', 'providers', 'mine']) !== undefined, '删除同步不影响用户自有路由')

  // ---------- 3. 全新 home：首次合并即产出合法形态 ----------
  console.log('\n[3] 全新文件')
  const homeC = join(root, 'home-c')
  await applySharedConfig(homeC, { providers: {}, credentials: { SHARED_X: 'sk-x' } }, null)
  const fresh = parseDocument(await readFile(join(homeC, '.credentials.yaml'), 'utf8'))
  ok(fresh.get('version') === 1, '缺失 version 时补 version: 1')
  ok(fresh.getIn(['refs', 'SHARED_X']) === 'sk-x', 'ref 落在 refs 下')
  ok(Object.keys(fresh.toJS()).every((k) => ['version', 'refs', 'records'].includes(k)), '全新文件顶层合法')

  // ---------- 4. 键名校验与 payload 解析 ----------
  console.log('\n[4] 校验与解析')
  ok(validateSharedConfigKeys({ providers: {}, credentials: { 'bad key': 'v' } }) !== null, '含空格的 ref 被拒绝')
  ok(validateSharedConfigKeys({ providers: { 'a/b': {} }, credentials: {} }) !== null, '含斜杠的 route 被拒绝')
  ok(validateSharedConfigKeys({ providers: { 'deepseek.v1': {} }, credentials: { SHARED_KEY: 'v' } }) === null, '合法键通过')
  const payload = parseSharedConfigPayload('{"providers":{"a":{}},"credentials":{"r":"k"}}')
  ok(payload.providers.a !== undefined && payload.credentials.r === 'k', 'payload JSON 解析')
  ok(parseSharedConfigPayload('{}').providers !== undefined && parseSharedConfigPayload('{}').credentials !== undefined, '空 payload 容错为空对象')

  console.log(`\n冒烟完成：${passed} 通过`)
  if (process.exitCode !== 1) process.exitCode = 0
} finally {
  await rm(root, { recursive: true, force: true }).catch(() => {})
}
