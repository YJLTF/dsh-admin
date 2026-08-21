// 共享模型配置：管理员发布提供方/凭据，用户选择接收；合并是叶子级的（用户自己的
// 提供方/凭据保留），删除只影响共享的路由/引用，防护栏不破。
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildServer } from '../lib/web/server.js'
import { resolveConfig } from '../lib/config.js'
import { createUser } from '../lib/db/repo.js'
import { hashPassword } from '../lib/web/auth.js'
import { assert, makeJson } from './helpers.mjs'

const dataRoot = mkdtempSync(join(tmpdir(), 'dsh-smoke-shared-'))
const app = await buildServer(resolveConfig({ port: 0, dbPath: ':memory:', dataRoot }))
await app.listen({ port: 0 })
const base = `http://127.0.0.1:${app.server.address().port}`

createUser(app.db, {
  id: 'admin', username: 'admin', passHash: await hashPassword('adminpass123'),
  role: 'admin', homeDir: join(dataRoot, 'users', 'admin', 'home'),
})
createUser(app.db, {
  id: 'bob', username: 'bob', passHash: await hashPassword('bobpass123'),
  role: 'active', homeDir: join(dataRoot, 'users', 'bob', 'home'),
})

const json = makeJson(base)

async function login(username, password) {
  const r = await json('/api/auth/login', { method: 'POST', body: { username, password } })
  assert(r.status === 200, `${username} 登录成功`)
  return r.setCookie.split(';')[0]
}

const bobHome = join(dataRoot, 'users', 'bob', 'home')
const readYaml = (name) => readFileSync(join(bobHome, name), 'utf8')

try {
  const admin = await login('admin', 'adminpass123')
  const bob = await login('bob', 'bobpass123')

  // 先查防护栏：非管理员写入、未认证读取、非法 key。
  let r = await json('/api/admin/shared-config', { method: 'PUT', cookie: bob, body: { payload: { providers: {}, credentials: {} } } })
  assert(r.status === 403, '非管理员 PUT → 403')
  r = await json('/api/me/shared-config')
  assert(r.status === 401, '未认证的用户读取 → 401')
  r = await json('/api/admin/shared-config', {
    method: 'PUT', cookie: admin,
    body: { payload: { providers: { 'bad route!': { displayName: 'x' } }, credentials: {} } },
  })
  assert(r.status === 400 && r.body.error === 'invalid_key', '非法路由 key → 400')
  r = await json('/api/admin/shared-config', {
    method: 'PUT', cookie: admin,
    body: { payload: { providers: { x: { models: [{ id: 'm', input: ['video'] }] } }, credentials: {} } },
  })
  assert(r.status === 400, '模型 input 含未知模态 → 400')
  r = await json('/api/admin/shared-config', {
    method: 'PUT', cookie: admin,
    body: { payload: { providers: { x: { defaultInput: [] } }, credentials: {} } },
  })
  assert(r.status === 400, 'defaultInput 为空 → 400')
  r = await json('/api/admin/shared-config', {
    method: 'PUT', cookie: admin,
    body: { payload: { providers: { x: { modelOverrides: { m: { input: ['audio'] } } } }, credentials: {} } },
  })
  assert(r.status === 400, 'modelOverrides 含未知模态 → 400')

  // v1：一个共享提供方（带模型清单 + 输入模态 + defaultInput）和一个共享凭据。
  const deepseekProfile = {
    displayName: 'DeepSeek 官方', baseURL: 'https://api.deepseek.com', apiKeyEnv: 'SHARED_DEEPSEEK_KEY',
    api: 'openai-completions', defaultInput: ['text'],
    models: [{ id: 'deepseek-chat' }, { id: 'vision-preview', input: ['text', 'image'] }],
  }
  r = await json('/api/admin/shared-config', {
    method: 'PUT', cookie: admin,
    body: { payload: { providers: { deepseek: deepseekProfile }, credentials: { SHARED_DEEPSEEK_KEY: 'sk-shared-111' } } },
  })
  assert(r.status === 200 && r.body.version === 1, '管理员保存 v1')

  // 无任何共享配置前的状态：此前验证为 401；现在 bob 能看到可接收的配置。
  r = await json('/api/me/shared-config', { cookie: bob })
  assert(r.status === 200 && r.body.available && r.body.updateAvailable, 'bob 看到可接收的配置')
  assert(r.body.providers.length === 1 && r.body.providers[0].route === 'deepseek', '提供方已列出')
  assert(r.body.credentialRefs.length === 1 && r.body.credentialRefs[0] === 'SHARED_DEEPSEEK_KEY', '凭据引用已列出')
  assert(!JSON.stringify(r.body).includes('sk-shared-111'), '凭据明文绝不暴露给用户')

  // 接收 → 文件写入 bob 的 DSH home。
  r = await json('/api/me/shared-config/accept', { method: 'POST', cookie: bob })
  assert(r.status === 200 && r.body.version === 1, 'bob 接收 v1')
  const settings1 = readYaml('settings.yaml')
  const creds1 = readYaml('.credentials.yaml')
  assert(settings1.includes('llm-pi-ai:') && settings1.includes('deepseek:') && settings1.includes('https://api.deepseek.com'), '提供方合并进 settings.yaml')
  assert(settings1.includes('SHARED_DEEPSEEK_KEY'), 'apiKeyEnv 已合并')
  assert(creds1.includes('SHARED_DEEPSEEK_KEY: sk-shared-111'), '凭据合并进 .credentials.yaml')
  {
    const { parseDocument } = await import('yaml')
    const ds = parseDocument(settings1).toJS()['llm-pi-ai'].providers.deepseek
    assert(ds.api === 'openai-completions', 'api 协议已合并')
    assert(ds.defaultInput.join(',') === 'text', 'defaultInput 已合并')
    assert(ds.models.length === 2 && ds.models[0].id === 'deepseek-chat' && ds.models[0].input === undefined, '未声明 input 的普通模型已合并')
    assert(ds.models[1].input.join(',') === 'text,image', '模型输入模态已合并')
  }

  // 无变更时重复接收：不再提示更新。
  r = await json('/api/me/shared-config', { cookie: bob })
  assert(!r.body.updateAvailable && r.body.acceptedVersion === 1, '接收后不再重复提示')

  // bob 直接在自己的 DSH home 里加自有提供方 + 凭据
  // （程序化编辑——手工追加的重复 key 会损坏文件，应用路径必须拒绝而不是悄悄搞坏）。
  const { writeFileSync } = await import('node:fs')
  const { parseDocument } = await import('yaml')
  const bobSettings = parseDocument(settings1)
  bobSettings.setIn(['llm-pi-ai', 'providers', 'myown'], { displayName: 'My Own' })
  writeFileSync(join(bobHome, 'settings.yaml'), String(bobSettings))
  const bobCreds = parseDocument(creds1)
  bobCreds.setIn(['MY_OWN_REF'], 'sk-bob-private')
  writeFileSync(join(bobHome, '.credentials.yaml'), String(bobCreds))

  // v2：管理员改共享凭据值并新增一个提供方
  // （带 modelOverrides 条目，即目录提供方参数）。
  r = await json('/api/admin/shared-config', {
    method: 'PUT', cookie: admin,
    body: {
      payload: {
        providers: {
          deepseek: deepseekProfile,
          other: { displayName: 'Other', baseURL: 'https://other.example/v1', modelOverrides: { 'claude-sonnet-4-5': { input: ['text'] } } },
        },
        credentials: { SHARED_DEEPSEEK_KEY: 'sk-shared-222' },
      },
    },
  })
  assert(r.status === 200 && r.body.version === 2, '管理员保存 v2')
  r = await json('/api/me/shared-config', { cookie: bob })
  assert(r.body.updateAvailable, '更新后 bob 再次被提示')

  r = await json('/api/me/shared-config/accept', { method: 'POST', cookie: bob })
  assert(r.status === 200 && r.body.version === 2, 'bob 接收 v2')
  const settings2 = readYaml('settings.yaml')
  const creds2 = readYaml('.credentials.yaml')
  assert(settings2.includes('other:'), '新的共享提供方已合并')
  assert(settings2.includes('myown:'), '用户自有提供方在合并后保留')
  assert(parseDocument(settings2).toJS()['llm-pi-ai'].providers.other.modelOverrides['claude-sonnet-4-5'].input.join(',') === 'text', 'modelOverrides 已合并')
  assert(creds2.includes('sk-shared-222') && !creds2.includes('sk-shared-111'), '共享凭据更新为 v2 的值')
  assert(creds2.includes('MY_OWN_REF: sk-bob-private'), '用户自有凭据在合并后保留')

  // v3：管理员彻底删掉 deepseek 提供方与该凭据。
  r = await json('/api/admin/shared-config', {
    method: 'PUT', cookie: admin,
    body: { payload: { providers: { other: { displayName: 'Other', baseURL: 'https://other.example/v1' } }, credentials: {} } },
  })
  assert(r.status === 200 && r.body.version === 3, '管理员保存 v3')
  r = await json('/api/me/shared-config/accept', { method: 'POST', cookie: bob })
  assert(r.status === 200, 'bob 接收 v3')
  const settings3 = readYaml('settings.yaml')
  const creds3 = readYaml('.credentials.yaml')
  assert(!settings3.includes('deepseek:'), '被删的共享提供方已移除')
  assert(settings3.includes('myown:') && settings3.includes('other:'), '保留的路由在删除后仍在')
  assert(!creds3.includes('SHARED_DEEPSEEK_KEY'), '被删的共享凭据已移除')
  assert(creds3.includes('MY_OWN_REF: sk-bob-private'), '自有凭据在删除后保留')

  // 完全没有共享配置时接收（管理员从未走过这条路径）：新用户。
  // 已隐式覆盖——current == accepted 时接收是幂等的。
  r = await json('/api/me/shared-config/accept', { method: 'POST', cookie: bob })
  assert(r.status === 200, '重复接收幂等')

  console.log('OK: 共享配置 发布/接收/合并/删除 流程（含 model input/defaultInput/modelOverrides）通过')
} finally {
  await app.close()
  rmSync(dataRoot, { recursive: true, force: true })
}
