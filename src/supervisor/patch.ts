/**
 * 子 DSH 的 cordis patch 渲染。始终挂载运行时插件
 * （`dsh-admin/runtime`），让每个子进程注入看门狗契约，
 * 外加每个已启用文件夹插件一行（id 兼作包名）。真实的
 * harness 通过 `--patch <file>` 加载它。
 * @module dsh-admin/supervisor/patch
 */

/** 运行时插件的 patch 行，挂载进每个子 DSH。 */
const RUNTIME_ROW = '    - id: dsh-admin-runtime\n      name: dsh-admin/runtime'

/** 渲染一段始终启用运行时插件外加 `enabledPlugins` 的 patch YAML。 */
export function renderPatch(enabledPlugins: readonly string[]): string {
  const rows = [RUNTIME_ROW, ...enabledPlugins.map((id) => `    - id: ${id}\n      name: ${id}`)]
  return `- insert:\n${rows.join('\n')}\n`
}
