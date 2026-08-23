// 插件市场流程：构造四种形态的 tgz（cordis 插件 / 技能 / 预设 / install 脚本）
// → 管理员导入（判定 + script/none 拒绝）→ 用户安装/更新/卸载（落盘 + patch 注册）
// → 管理员删除（用户记录级联）。全部离线，不依赖网络。
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as tar from 'tar'
import { buildServer } from '../lib/web/server.js'
import { resolveConfig } from '../lib/config.js'
import { createUser } from '../lib/db/repo.js'
import { hashPassword } from '../lib/web/auth.js'
import { assert, cleanup, makeJson } from './helpers.mjs'

const dataRoot = mkdtempSync(join(tmpdir(), 'dsh-smoke-market-'))
const fxRoot = mkdtempSync(join(tmpdir(), 'dsh-smoke-market-fx-'))

/** 在 fxRoot 下造一个 fixture 目录并打包成 tgz，返回 tgz 路径。 */
async function pack(dirName, files) {
  const dir = join(fxRoot, dirName)
  mkdirSync(dir, { recursive: true })
  for (const [rel, content] of Object.entries(files)) {
    const file = join(dir, rel)
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, content)
  }
  const tgz = join(fxRoot, `${dirName}.tgz`)
  await tar.c({ file: tgz, cwd: fxRoot, gzip: true }, [dirName])
  return tgz
}

const pluginTgz = await pack('fx-hello-abc1234def', {
  'package.json': JSON.stringify({
    name: 'fx-hello',
    version: '1.0.0',
    description: 'fixture plugin',
    main: './lib/index.js',
    dsh: { plugin: true, kind: 'server' },
  }),
  'lib/index.js': 'export const fx = true\n',
})
const pluginV2Tgz = await pack('fx-hello-v2', {
  'package.json': JSON.stringify({ name: 'fx-hello', version: '2.0.0', description: 'fixture plugin v2', dsh: { plugin: true } }),
  'lib/index.js': 'export const fx = 2\n',
})
const skillTgz = await pack('fx-skill-repo', {
  'SKILL.md': '---\nname: fx-skill\ndescription: 测试技能\n---\n\n# 测试技能\n\n第一行说明文字。\n',
})
const presetTgz = await pack('fx-preset-main', {
  'preset.yml': 'name: fx\n',
  'agent.cordis.yml': '[]\n',
})
const scriptTgz = await pack('fx-script', { 'install.sh': 'echo nope\n' })
const noneTgz = await pack('fx-none', { 'README.md': '# nothing\n' })

const app = await buildServer(resolveConfig({ port: 0, dbPath: ':memory:', dataRoot }))
await app.listen({ port: 0 })
const base = `http://127.0.0.1:${app.server.address().port}`

createUser(app.db, {
  id: 'admin',
  username: 'admin',
  passHash: await hashPassword('adminpass123'),
  role: 'admin',
  homeDir: join(dataRoot, 'users', 'admin', 'home'),
})
createUser(app.db, {
  id: 'u1',
  username: 'dave',
  passHash: await hashPassword('davepass123'),
  role: 'active',
  homeDir: join(dataRoot, 'users', 'u1', 'home'),
})

const json = makeJson(base)

/** multipart 导入封装。 */
async function importTgz(cookie, tgzPath) {
  const bytes = readFileSync(tgzPath)
  const fd = new FormData()
  fd.append('file', new File([bytes], 'fixture.tgz'))
  const res = await fetch(base + '/api/admin/market/import', { method: 'POST', headers: { cookie }, body: fd })
  return { status: res.status, body: await res.json().catch(() => null) }
}

try {
  let r

  r = await json('/api/auth/login', { method: 'POST', body: { username: 'admin', password: 'adminpass123' } })
  assert(r.status === 200 && r.setCookie, '管理员登录')
  const adminCookie = r.setCookie.split(';')[0]
  r = await json('/api/auth/login', { method: 'POST', body: { username: 'dave', password: 'davepass123' } })
  assert(r.status === 200 && r.setCookie, 'dave 登录')
  const daveCookie = r.setCookie.split(';')[0]

  // 非管理员不可导入。
  r = await importTgz(daveCookie, pluginTgz)
  assert(r.status === 403, '普通用户不可导入')

  // ---------- 导入与判定 ----------
  r = await importTgz(adminCookie, pluginTgz)
  console.log('导入插件       ->', r.status, r.body?.item?.name, r.body?.item?.version)
  assert(r.status === 200 && r.body.item.kind === 'cordis-plugin' && r.body.item.name === 'fx-hello' && r.body.item.version === '1.0.0', 'cordis 插件判定 + 剥离归档顶层目录')
  const pluginId = r.body.item.id

  r = await importTgz(adminCookie, scriptTgz)
  console.log('导入脚本型     ->', r.status, r.body?.error)
  assert(r.status === 422 && r.body.error === 'script_kind_unsupported', 'install 脚本型被拒绝')

  r = await importTgz(adminCookie, noneTgz)
  assert(r.status === 422 && r.body.error === 'no_market_signature', '无特征仓库被拒绝')

  r = await importTgz(adminCookie, skillTgz)
  console.log('导入技能       ->', r.status, r.body?.item?.name)
  assert(r.status === 200 && r.body.item.kind === 'skill' && r.body.item.name === 'fx-skill', 'SKILL.md 判定为技能（frontmatter 名）')
  assert(r.body.item.description.includes('测试技能') || r.body.item.description.includes('说明'), '技能描述取自正文')

  r = await importTgz(adminCookie, presetTgz)
  console.log('导入预设       ->', r.status, r.body?.item?.name)
  assert(r.status === 200 && r.body.item.kind === 'agent-preset' && r.body.item.name === 'fx-preset', 'preset 组合判定（剥 -main 后缀）')
  const presetId = r.body.item.id

  // 重复导入同版本 = 覆盖（同 id）。
  r = await importTgz(adminCookie, pluginTgz)
  assert(r.status === 200 && r.body.item.id === pluginId, '重复导入覆盖同一条目')

  // ---------- 用户侧列表与安装 ----------
  r = await json('/api/me/market', { cookie: daveCookie })
  assert(r.status === 200 && r.body.items.length === 3, '市场列出 3 个条目')
  assert(r.body.installed.length === 0, '初始无安装')

  r = await json('/api/me/market/' + pluginId + '/install', { method: 'POST', cookie: daveCookie })
  console.log('安装插件       ->', r.status)
  assert(r.status === 200 && r.body.restartRecommended === false, '安装成功（无运行实例不提示重启）')

  const profileWeb = join(dataRoot, 'users', 'u1', 'home', 'profiles', 'web')
  assert(existsSync(join(profileWeb, 'node_modules', 'fx-hello', 'lib', 'index.js')), '插件落到 profiles/web/node_modules')
  const patchFile = join(profileWeb, 'cordis.patch.yml')
  assert(existsSync(patchFile), 'cordis.patch.yml 已创建')
  let patchText = readFileSync(patchFile, 'utf8')
  console.log('patch          ->', JSON.stringify(patchText))
  assert(patchText.includes('fx-hello'), 'patch 注册了插件行')

  r = await json('/api/me/market', { cookie: daveCookie })
  assert(r.body.installed.some((p) => p.name === 'fx-hello' && p.version === '1.0.0'), '安装记录带版本')

  // .git 排除：打包目录带 .git/ 时（此处直接构造一个含 .git 的包）。
  const gitTgz = await pack('fx-gitcheck-main', {
    'package.json': JSON.stringify({ name: 'fx-gitcheck', version: '0.0.1', dsh: { plugin: true } }),
    '.git/config': '[core]\n',
    'lib/index.js': 'export default 1\n',
  })
  r = await importTgz(adminCookie, gitTgz)
  assert(r.status === 200, '含 .git 的包导入成功')
  r = await json('/api/me/market/' + r.body.item.id + '/install', { method: 'POST', cookie: daveCookie })
  assert(r.status === 200, '安装含 .git 的包')
  assert(!existsSync(join(profileWeb, 'node_modules', 'fx-gitcheck', '.git')), '.git 目录被排除')

  // ---------- 与 profile bundles 冲突 ----------
  mkdirSync(profileWeb, { recursive: true })
  writeFileSync(join(profileWeb, 'package.json'), JSON.stringify({ name: 'dsh-profile-web', dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'fx-hello'] } } }))
  const conflictTgz = await pack('fx-bundle-conflict', {
    'package.json': JSON.stringify({ name: 'fx-hello', version: '9.9.9', dsh: { plugin: true } }),
  })
  r = await importTgz(adminCookie, conflictTgz)
  assert(r.status === 200, '同名包 v9 导入成功')
  r = await json('/api/me/market/' + r.body.item.id + '/install', { method: 'POST', cookie: daveCookie })
  assert(r.status === 409 && r.body.error === 'conflicts_with_profile_bundle', 'bundles 里已有同名包 → 409 防双注册')
  // 清理：恢复无冲突的 profile manifest。
  writeFileSync(join(profileWeb, 'package.json'), JSON.stringify({ name: 'dsh-profile-web', dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } }))

  // ---------- 更新 ----------
  r = await importTgz(adminCookie, pluginV2Tgz)
  assert(r.status === 200 && r.body.item.version === '2.0.0', '导入 v2')
  r = await json('/api/me/market', { cookie: daveCookie })
  const installed = r.body.installed.find((p) => p.name === 'fx-hello')
  assert(installed !== undefined && installed.updateAvailable === true && installed.latestVersion === '2.0.0', '检测到可用更新')
  r = await json('/api/me/market/' + r.body.items.find((i) => i.name === 'fx-hello' && i.version === '2.0.0').id + '/install', { method: 'POST', cookie: daveCookie })
  assert(r.status === 200, '安装 v2（覆盖更新）')
  assert(readFileSync(join(profileWeb, 'node_modules', 'fx-hello', 'package.json'), 'utf8').includes('2.0.0'), '落盘已是 v2')

  // ---------- 技能 / 预设安装 ----------
  r = await json('/api/me/market', { cookie: daveCookie })
  const skillItem = r.body.items.find((i) => i.kind === 'skill')
  r = await json('/api/me/market/' + skillItem.id + '/install', { method: 'POST', cookie: daveCookie })
  assert(r.status === 200, '安装技能')
  assert(existsSync(join(dataRoot, 'users', 'u1', 'home', 'skills', 'fx-skill', 'SKILL.md')), '技能落到 ~/.dsh/skills')

  r = await json('/api/me/market/' + presetId + '/install', { method: 'POST', cookie: daveCookie })
  assert(r.status === 200, '安装预设')
  assert(existsSync(join(dataRoot, 'users', 'u1', 'home', '.agent-presets', 'fx-preset', 'preset.yml')), '预设落到 ~/.dsh/.agent-presets')

  // ---------- 卸载 ----------
  r = await json('/api/me/market/uninstall', { method: 'POST', cookie: daveCookie, body: { name: 'fx-hello' } })
  assert(r.status === 200, '卸载插件')
  assert(!existsSync(join(profileWeb, 'node_modules', 'fx-hello')), '插件目录已删除')
  patchText = existsSync(patchFile) ? readFileSync(patchFile, 'utf8') : ''
  assert(!patchText.includes('fx-hello'), 'patch 行已移除')
  r = await json('/api/me/market/uninstall', { method: 'POST', cookie: daveCookie, body: { name: 'fx-hello' } })
  assert(r.status === 404, '重复卸载返回 404')

  // ---------- 管理员删除条目（用户记录级联） ----------
  r = await json('/api/admin/market/' + presetId, { method: 'DELETE', cookie: adminCookie })
  assert(r.status === 200, '删除预设条目')
  r = await json('/api/me/market', { cookie: daveCookie })
  assert(!r.body.items.some((i) => i.id === presetId), '市场列表不再包含该条目')
  assert(!r.body.installed.some((p) => p.name === 'fx-preset'), '用户安装记录随外键级联消失')

  // 审计。
  r = await json('/api/admin/audit?limit=200', { cookie: adminCookie })
  const actions = new Set(r.body.rows.map((row) => row.action))
  assert(actions.has('market_import') && actions.has('plugin_install') && actions.has('plugin_uninstall') && actions.has('market_delete'), '审计覆盖市场操作')

  console.log('OK: 插件市场（导入判定/安装落盘/更新/卸载/删除级联）通过')
} finally {
  await app.close()
  cleanup(dataRoot)
  cleanup(fxRoot)
}
