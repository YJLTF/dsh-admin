/**
 * 插件市场域逻辑冒烟测试（无需起服务器）：
 *   判型/多根扫描（插件/技能/预设/脚本拒绝/技能合集/多包仓库/深度与
 *   vendored 跳过）→ 披露解析（package.json + SKILL.md frontmatter）→
 *   offline-packager meta 解析 → 自包含判定 → dump-config 校验降级 →
 *   安装落盘与 patch 注册 → 卸载清理 → dsh-cli.tgz 校验与原子替换
 *   （有 scripts/dsh-cli.tgz 时做真实替换；Windows 无符号链接权限时跳过）。
 *
 * 运行：npm run build && npm run smoke:market
 */
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as tar from 'tar'

const lib = '../lib/fs/market.js'
const { extractTgz, scanMarketRoots, readMarketMeta, readMarketDisclosure, parsePackMeta, validatePluginConfig, installMarketItem, uninstallMarketItem, supportsLivePatchReload } = await import(lib)
const dshCli = '../lib/fs/dsh-cli.js'
const { InvalidCliArchiveError, readDshCliInfo, updateDshCli } = await import(dshCli)
const sharedSync = '../lib/fs/shared-sync.js'
const { normalizeSharedPatch, syncSharedItemsForUser, writeSharedPatch, removeSharedPatch } = await import(sharedSync)

let passed = 0
let skipped = 0

function ok(cond, name) {
  if (!cond) {
    console.error(`  ✗ ${name}`)
    process.exitCode = 1
    throw new Error(`断言失败：${name}`)
  }
  passed++
  console.log(`  ✓ ${name}`)
}

function skip(name, reason) {
  skipped++
  console.log(`  - 跳过 ${name}（${reason}）`)
}

/** ServerConfig 的最小替身：market 域逻辑只读这几个字段。 */
function fakeConfig(dataRoot, extra = {}) {
  return { dataRoot, dshCommand: [], dshCliDir: '', ...extra }
}

async function writeTree(dir, files) {
  for (const [rel, content] of Object.entries(files)) {
    const file = join(dir, rel)
    await mkdir(file.slice(0, file.lastIndexOf(join.sep)), { recursive: true })
    await writeFile(file, content)
  }
}

/** 打包目录为 tgz（顶层带一个随机名目录，模拟 git codeload 归档）。 */
async function packAsArchive(srcDir, out, topName) {
  await tar.c({ gzip: true, file: out, cwd: srcDir, portable: true }, [topName])
}

const root = await mkdtemp(join(tmpdir(), 'dsh-smoke-'))
const archives = join(root, 'archives')
const extracted = join(root, 'extracted')
const dataRoot = join(root, 'data')
await mkdir(archives)
await mkdir(extracted)
await mkdir(dataRoot)

try {
  // ---------- 1. 根目录判型：插件 / 技能 / 预设 / 脚本拒绝 ----------
  console.log('\n[1] 根目录判型')
  const pluginPkg = JSON.stringify({
    name: 'dsh-smoke-plugin',
    version: '1.2.3',
    description: 'smoke fixture',
    main: './lib/index.js',
    dsh: { plugin: true, kind: 'server' },
  })
  const pluginDir = join(root, 'src-plugin')
  await writeTree(pluginDir, {
    'repo-main/package.json': pluginPkg,
    'repo-main/lib/index.js': 'export default 1\n',
  })
  const pluginTgz = join(archives, 'plugin.tgz')
  await packAsArchive(pluginDir, pluginTgz, 'repo-main')

  const pluginSrc = await extractTgz(pluginTgz, join(extracted, 'plugin'))
  let scan = await scanMarketRoots(pluginSrc)
  ok(scan.rootKind === 'cordis-plugin' && scan.roots.length === 1 && scan.roots[0].kind === 'cordis-plugin', '根 package.json + dsh 字段 → cordis-plugin')
  const pluginMeta = await readMarketMeta(scan.roots[0].dir, 'cordis-plugin')
  ok(pluginMeta.name === 'dsh-smoke-plugin' && pluginMeta.version === '1.2.3', '插件元数据（包名/版本）')
  ok(pluginMeta.selfContained === true, '无运行时依赖 → 视为自包含')

  const skillDir = join(root, 'src-skill')
  await writeTree(skillDir, { 'repo-skill/SKILL.md': '---\nname: smoke-skill\ndescription: x\ncloud: false\noffline_mode: true\n---\n\n# 技能\n' })
  const skillTgz = join(archives, 'skill.tgz')
  await packAsArchive(skillDir, skillTgz, 'repo-skill')
  const skillSrc = await extractTgz(skillTgz, join(extracted, 'skill'))
  scan = await scanMarketRoots(skillSrc)
  ok(scan.rootKind === 'skill' && scan.roots.length === 1, '根 SKILL.md → skill')
  const skillMeta = await readMarketMeta(scan.roots[0].dir, 'skill')
  ok(skillMeta.name === 'smoke-skill', '技能名取 frontmatter name')
  const skillDisclosure = await readMarketDisclosure(scan.roots[0].dir, 'skill')
  ok(skillDisclosure.declared === true && skillDisclosure.cloud === false && skillDisclosure.offlineMode === true, '技能披露来自 SKILL.md frontmatter')

  const presetDir = join(root, 'src-preset')
  await writeTree(presetDir, { 'repo-preset/preset.yml': 'name: smoke-preset\n', 'repo-preset/agent.cordis.yml': 'components: {}\n' })
  const presetTgz = join(archives, 'preset.tgz')
  await packAsArchive(presetDir, presetTgz, 'repo-preset')
  const presetSrc = await extractTgz(presetTgz, join(extracted, 'preset'))
  scan = await scanMarketRoots(presetSrc)
  ok(scan.rootKind === 'agent-preset' && scan.roots.length === 1, '根 preset.yml + agent.cordis.yml → agent-preset')

  const scriptDir = join(root, 'src-script')
  await writeTree(scriptDir, { 'repo-script/install.sh': '#!/bin/sh\n' })
  const scriptTgz = join(archives, 'script.tgz')
  await packAsArchive(scriptDir, scriptTgz, 'repo-script')
  const scriptSrc = await extractTgz(scriptTgz, join(extracted, 'script'))
  scan = await scanMarketRoots(scriptSrc)
  ok(scan.rootKind === 'script' && scan.roots.length === 0, '根 install.sh → script（路由层 422）')

  // ---------- 2. 子目录扫描：技能合集 + 多包仓库 + 深度/排除 ----------
  console.log('\n[2] 子目录扫描（STANDARD §1 顺序 5/8/9）')
  const collDir = join(root, 'src-collection')
  await writeTree(collDir, {
    'repo-collection/presets/team-preset/preset.yml': 'name: team-preset\n',
    'repo-collection/presets/team-preset/agent.cordis.yml': 'components: {}\n',
    'repo-collection/plugins/dsh-smoke-b/package.json': JSON.stringify({ name: 'dsh-smoke-b', version: '0.2.0', dsh: { plugin: true }, main: './index.js' }),
    'repo-collection/plugins/dsh-smoke-b/index.js': 'export default 2\n',
    'repo-collection/skills/alpha/SKILL.md': '---\nname: alpha\n---\n技能 A\n',
    'repo-collection/skills/beta/SKILL.md': '---\nname: beta\n---\n技能 B\n',
    'repo-collection/upstream/nested/SKILL.md': '不应被收录\n',
    'repo-collection/.hidden/x/SKILL.md': '不应被收录\n',
  })
  const collTgz = join(archives, 'collection.tgz')
  await packAsArchive(collDir, collTgz, 'repo-collection')
  const collSrc = await extractTgz(collTgz, join(extracted, 'collection'))
  scan = await scanMarketRoots(collSrc)
  const kinds = scan.roots.map((r) => `${r.kind}:${r.dir.split(/[\\/]/).pop()}`)
  ok(scan.rootKind === 'none', '根无特征 → 子目录扫描')
  ok(kinds.includes('agent-preset:team-preset'), `子目录预设收录（${kinds.join(', ')}）`)
  ok(kinds.includes('cordis-plugin:dsh-smoke-b'), '子目录插件收录')
  ok(kinds.includes('skill:alpha') && kinds.includes('skill:beta'), '技能合集逐个收录')
  ok(!kinds.some((k) => k.includes('upstream') || k.includes('hidden')), 'vendored / 点目录被跳过')
  ok(scan.roots.length === 4, `共 4 个条目根（实际 ${scan.roots.length}）`)

  // ---------- 3. 披露（package.json disclosure）与 offline-packager meta ----------
  console.log('\n[3] 披露与打包元数据')
  const cloudPluginDir = join(root, 'src-cloud')
  await writeTree(cloudPluginDir, {
    'repo-cloud/package.json': JSON.stringify({
      name: 'dsh-smoke-cloud',
      version: '0.1.0',
      dsh: { plugin: true },
      dependencies: { 'real-dep': '^1.0.0' },
      bundledDependencies: ['real-dep'],
      disclosure: { cloud: true, network: ['https://example.com'], retention: 'session' },
    }),
  })
  const cloudSrc = join(cloudPluginDir, 'repo-cloud')
  const cloudDisclosure = await readMarketDisclosure(cloudSrc, 'cordis-plugin')
  ok(cloudDisclosure.cloud === true && cloudDisclosure.network[0] === 'https://example.com' && cloudDisclosure.retention === 'session', '插件披露来自 package.json disclosure')
  const cloudMeta = await readMarketMeta(cloudSrc, 'cordis-plugin')
  ok(cloudMeta.selfContained === true, 'bundledDependencies 覆盖全部运行时依赖 → 自包含')

  const packMeta = parsePackMeta(JSON.stringify({ source: 'npm:@deepseek-ai/dsh-base', dshVersion: '0.1.2-rc.1', packedAt: '2026-09-01T00:00:00Z', bundledDependencies: ['x'] }))
  ok(packMeta !== null && packMeta.dshVersion === '0.1.2-rc.1' && packMeta.selfContained === true, 'offline-packager meta.json 解析')
  ok(parsePackMeta('not-json') === null && parsePackMeta('[]') === null, '非法 meta.json → null')

  // ---------- 4. 沙箱启动探测校验 ----------
  console.log('\n[4] 沙箱启动探测校验')
  // 无 dsh CLI（默认）→ 必须优雅降级为 skipped，绝不抛错。
  const validation = await validatePluginConfig(fakeConfig(dataRoot, { dshCommand: ['dsh-smoke-nonexistent-cli'] }), pluginSrc, 'dsh-smoke-plugin')
  ok(validation.status === 'skipped' && typeof validation.detail === 'string', `dsh 不可用 → skipped（${validation.detail?.slice(0, 40)}…）`)
  // 设置 DSH_SMOKE_DSH_BIN='node "<路径>/bin.js"' 时用真实 CLI 做端到端
  // （约 2 次 web 启动；需要一个 apply 空操作的合法 cordis 插件与一个坏插件）。
  const realBin = process.env.DSH_SMOKE_DSH_BIN
  if (realBin) {
    const { parseCommandString } = await import('../lib/config.js')
    const realConfig = fakeConfig(dataRoot, { dshCommand: parseCommandString(realBin) })
    const goodDir = join(root, 'probe-good')
    await mkdir(join(goodDir, 'lib'), { recursive: true })
    await writeFile(join(goodDir, 'package.json'), JSON.stringify({ name: 'dsh-probe-good', version: '1.0.0', dsh: { plugin: true, kind: 'server' }, main: './lib/index.js' }))
    await writeFile(join(goodDir, 'lib', 'index.js'), 'export default { name: "dsh-probe-good", apply: () => {} }\n')
    const r1 = await validatePluginConfig(realConfig, goodDir, 'dsh-probe-good')
    ok(r1.status === 'pass', `真实 CLI：合法插件 → pass（${JSON.stringify(r1).slice(0, 60)}…）`)
    const uglyDir = join(root, 'probe-ugly')
    await mkdir(join(uglyDir, 'lib'), { recursive: true })
    await writeFile(join(uglyDir, 'package.json'), JSON.stringify({ name: 'dsh-probe-ugly', version: '1.0.0', dsh: { plugin: true }, main: './lib/index.js' }))
    await writeFile(join(uglyDir, 'lib', 'index.js'), '这不是合法的 JS {{{\n')
    const r2 = await validatePluginConfig(realConfig, uglyDir, 'dsh-probe-ugly')
    ok(r2.status === 'fail', '真实 CLI：语法坏 JS → fail（启动即崩）')
  } else {
    skip('真实 CLI 启动探测', '未设置 DSH_SMOKE_DSH_BIN（例如 node "<dsh>/lib/bin.js"）')
  }

  // ---------- 5. 安装 / 卸载 ----------
  console.log('\n[5] 安装与卸载')
  const config = fakeConfig(dataRoot)
  const userId = 'u-smoke'
  await installMarketItem(config, userId, { kind: 'cordis-plugin', name: 'dsh-smoke-plugin', dir: pluginSrc })
  const home = join(dataRoot, 'users', userId, 'home')
  const patchText = await readFile(join(home, 'profiles', 'web', 'cordis.patch.yml'), 'utf8')
  ok(patchText.includes('id: dsh-smoke-plugin'), '安装写 profile patch 行')
  await uninstallMarketItem(config, userId, 'cordis-plugin', 'dsh-smoke-plugin')
  ok(!(await patchTextSafe(join(home, 'profiles', 'web', 'cordis.patch.yml'), 'dsh-smoke-plugin')), '卸载移除 patch 行')

  // ---------- 5b. 共享推送（管理员推送全员）----------
  console.log('\n[5b] 共享推送与共享 patch')
  const { openDatabase } = await import('../lib/db/connection.js')
  const { runMigrations } = await import('../lib/db/schema.js')
  const { createUser, insertMarketItem, findUserPluginByName, setMarketItemShared, listSharedMarketItems } = await import('../lib/db/repo.js')
  const db = openDatabase(':memory:')
  runMigrations(db)
  createUser(db, { id: 'u-push', username: 'push', passHash: 'x', role: 'active' })
  insertMarketItem(db, { id: 'it-shared', kind: 'skill', name: 'pushed-skill', version: '1.0.0', description: '', dir: skillSrc, warnings: '[]' })
  insertMarketItem(db, { id: 'it-plugin', kind: 'cordis-plugin', name: 'dsh-smoke-plugin', version: '1.2.3', description: '', dir: pluginSrc, warnings: '[]' })
  setMarketItemShared(db, 'it-plugin', true)
  setMarketItemShared(db, 'it-shared', true)
  ok(listSharedMarketItems(db).length === 1, '共享列表只含技能/预设（cordis 插件被过滤）')
  const pushConfig = fakeConfig(dataRoot)
  ok(await syncSharedItemsForUser(pushConfig, db, 'u-push') === 1, '推送同步安装 1 个技能')
  const pushed = findUserPluginByName(db, 'u-push', 'pushed-skill')
  ok(pushed !== undefined && pushed.source === 'shared', '安装记录 source=shared')
  ok(await exists(join(dataRoot, 'users', 'u-push', 'home', 'skills', 'pushed-skill', 'SKILL.md')), '推送技能落盘用户 home')
  ok(await syncSharedItemsForUser(pushConfig, db, 'u-push') === 0, '版本一致时不重复安装')

  ok(normalizeSharedPatch('').ok && normalizeSharedPatch('').yaml === '', '空 patch 归一化为空串')
  ok(normalizeSharedPatch('- disable: x\n').ok, '合法 patch ops 通过')
  ok(!normalizeSharedPatch('key: value').ok, '非数组 patch 被拒绝')
  ok(!normalizeSharedPatch('- just a string').ok, '非映射项被拒绝')
  const patchFile = join(dataRoot, 'users', 'u-push', 'home', 'cordis.patch.yml')
  await writeSharedPatch(pushConfig, 'u-push', '- disable: x\n')
  ok((await readFile(patchFile, 'utf8')) === '- disable: x\n', 'home 级共享 patch 原子写入')
  await removeSharedPatch(pushConfig, 'u-push')
  ok(!(await exists(patchFile)), '清空共享 patch 后删除用户文件')

  // ---------- 6. dsh CLI 更新 ----------
  console.log('\n[6] dsh CLI 更新（fs/dsh-cli）')
  const cliDir = join(root, 'cli')
  const oldModules = join(cliDir, 'node_modules')
  await writeTree(oldModules, { '@deepseek-ai/dsh/package.json': JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.0.0-placeholder' }) })
  const cliConfig = fakeConfig(dataRoot, { dshCliDir: cliDir })
  let info = await readDshCliInfo(cliConfig)
  ok(info !== null && info.installedVersion === '0.0.0-placeholder', 'readDshCliInfo 读当前版本')
  ok(await readDshCliInfo(fakeConfig(dataRoot)) === null, '未配置 dshCliDir → null（平台不管理）')

  // 垃圾归档（无 .bin）必须拒绝且不破坏现有安装
  const badDir = join(root, 'src-badcli')
  await writeTree(badDir, { 'node_modules/@deepseek-ai/dsh/package.json': JSON.stringify({ name: '@deepseek-ai/dsh', version: '9.9.9' }) })
  const badTgz = join(archives, 'badcli.tgz')
  await packAsArchive(badDir, badTgz, 'node_modules')
  let rejected = false
  try {
    await updateDshCli(cliConfig, badTgz)
  } catch (err) {
    rejected = err instanceof InvalidCliArchiveError
  }
  ok(rejected, '缺 .bin 的归档被拒绝（InvalidCliArchiveError）')
  ok((await readFile(join(oldModules, '@deepseek-ai/dsh/package.json'), 'utf8')).includes('0.0.0-placeholder'), '拒绝后现有 node_modules 完好')

  // 真实 dsh-cli.tgz 端到端（Windows 无符号链接权限时解包失败 → 跳过）
  let realTgz = null
  try {
    realTgz = join('scripts', 'dsh-cli.tgz')
    await readFile(realTgz)
  } catch {
    realTgz = null
  }
  if (realTgz === null) {
    skip('真实归档替换', 'scripts/dsh-cli.tgz 不存在（先跑 scripts/pack-dsh.ps1）')
  } else {
    try {
      const result = await updateDshCli(cliConfig, realTgz)
      const newPkg = JSON.parse(await readFile(join(cliDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf8'))
      ok(result.previousVersion === '0.0.0-placeholder' && result.newVersion === newPkg.version, `真实归档原子替换（${result.previousVersion} → ${result.newVersion}）`)
      const leftovers = (await readdir(cliDir)).filter((name) => name.startsWith('.node_modules.old-') || name.startsWith('.update-staging-'))
      ok(leftovers.length === 0, '备份与 staging 目录已清理')
      ok(await exists(join(cliDir, 'node_modules', '.bin')), '替换后 .bin 就位')
    } catch (err) {
      // 只按 EPERM/symlink 识别解包权限问题；不能含中文「符号链接」——
      // 那是 InvalidCliArchiveError 的文案，宽匹配会把真实回归吞成跳过。
      if (process.platform === 'win32' && /EPERM|symlink/i.test(String(err))) {
        skip('真实归档替换', 'Windows 无符号链接权限——容器/Linux 环境运行即可覆盖')
      } else {
        throw err
      }
    }
  }

  // 免符号链接的布局回归：pack-dsh.ps1 形态（唯一顶层 node_modules/，
  // 会被 extractTgz 按 codeload 规则剥离）与顶层多项的散装形态都必须
  // 通过校验并整体换名——用例不依赖符号链接，Windows 上即可运行。
  console.log('\n[6b] dsh-cli 归档布局回归（无符号链接）')
  const cliDir2 = join(root, 'cli2')
  await mkdir(cliDir2, { recursive: true })
  const cliConfig2 = fakeConfig(dataRoot, { dshCliDir: cliDir2 })
  const fakeCliSrc = join(root, 'src-fakecli')
  await writeTree(fakeCliSrc, {
    'node_modules/@deepseek-ai/dsh/package.json': JSON.stringify({ name: '@deepseek-ai/dsh', version: '8.8.8' }),
    'node_modules/.bin/dsh': '#!/bin/sh\n',
  })
  const fakeTgz = join(archives, 'fakecli.tgz')
  await packAsArchive(fakeCliSrc, fakeTgz, 'node_modules')
  const rFake = await updateDshCli(cliConfig2, fakeTgz)
  ok(rFake.previousVersion === null && rFake.newVersion === '8.8.8', 'pack-dsh.ps1 形态（顶层 node_modules 被剥离）校验通过')
  ok(await exists(join(cliDir2, 'node_modules', '.bin', 'dsh')), '剥离形态：node_modules 整体就位')
  const looseCliSrc = join(root, 'src-fakecli-loose')
  await writeTree(looseCliSrc, {
    '@deepseek-ai/dsh/package.json': JSON.stringify({ name: '@deepseek-ai/dsh', version: '8.8.9' }),
    '.bin/dsh': '#!/bin/sh\n',
  })
  const looseTgz = join(archives, 'fakecli-loose.tgz')
  // 不能把 '@deepseek-ai' 直接作为打包条目（node-tar 会当成 @file 引用），打整个目录。
  await tar.c({ gzip: true, file: looseTgz, cwd: looseCliSrc, portable: true }, ['.'])
  const rLoose = await updateDshCli(cliConfig2, looseTgz)
  ok(rLoose.previousVersion === '8.8.8' && rLoose.newVersion === '8.8.9', '散装形态（顶层多项不剥离）校验通过并二次替换')
  ok(await exists(join(cliDir2, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')), '散装形态：node_modules 整体就位')
  const cli2Leftovers = (await readdir(cliDir2)).filter((name) => name.startsWith('.node_modules.old-') || name.startsWith('.update-staging-'))
  ok(cli2Leftovers.length === 0, '备份与 staging 目录已清理')

  // ---------- 7. 版本判定 ----------
  console.log('\n[7] live patch 重载版本判定')
  ok(supportsLivePatchReload('0.1.2-rc.1') === true, '0.1.2-rc.1 → true（验证下限）')
  ok(supportsLivePatchReload('0.1.2') === true, '0.1.2 正式版 → true')
  ok(supportsLivePatchReload('0.1.2-rc.2') === true, '0.1.2-rc.2 → true')
  ok(supportsLivePatchReload('0.1.1-rc.9') === false, '0.1.1-rc.9 → false')
  ok(supportsLivePatchReload('0.1.2-alpha.5') === false, '0.1.2-alpha.5 → false（prerelease 早于 rc.1）')
  ok(supportsLivePatchReload('0.2.0') === true, '0.2.0 → true')
  ok(supportsLivePatchReload(null) === false && supportsLivePatchReload('unknown') === false, '版本未知 → false（保守回退重启语义）')

  console.log(`\n冒烟完成：${passed} 通过，${skipped} 跳过`)
  if (process.exitCode !== 1) process.exitCode = 0
} finally {
  await rm(root, { recursive: true, force: true }).catch(() => {})
}

/** 卸载后 patch 文件里不应再有该 id（文件可能整体消失）。 */
async function patchTextSafe(file, id) {
  try {
    return (await readFile(file, 'utf8')).includes(`id: ${id}`)
  } catch {
    return false
  }
}

async function exists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}
