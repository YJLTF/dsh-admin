/**
 * 加载进每个子 DSH 的运行时插件（由编排器生成的 patch 挂载）。它是
 * 本包的一部分（不是 harness 侧改动），读取拉起进程时注入的环境变量契约：
 *
 *   DSH_ADMIN_PORT          — Web 服务器必须绑定的环回端口（main）
 *   DSH_ADMIN_ROLE          — 'main' | 'watchdog'
 *   DSH_ADMIN_HANDOFF_PATH  — 重启后命令交接文件（两种角色都用）
 *   DSH_HOME                       — 用户主目录（状态 + 凭据）
 *
 * 在 MAIN 角色下，它还会注册一段系统提示，告知 agent 看门狗 DSH 与
 * 重启契约的存在：当需要重启时（例如安装插件之后），agent 先把重启后
 * 要执行的命令写入交接路径，编排器随后拉起一个一次性的看门狗，在主
 * 实例重新启动后执行该命令。
 * @module dsh-admin/runtime
 */

export const name = 'dsh-admin-runtime'

/** 本插件依赖的 `ctx.systemPrompt.section()` 契约（结构定义）。 */
export interface PromptSection {
  name: string
  order: number
  text: string | ((context: unknown) => string)
}

export interface RuntimeEnv {
  role: 'main' | 'watchdog'
  port?: number
  handoffPath?: string
}

/** 解析由编排器注入的环境变量契约。 */
export function readRuntimeEnv(env: NodeJS.ProcessEnv = process.env): RuntimeEnv {
  const role = env.DSH_ADMIN_ROLE === 'watchdog' ? 'watchdog' : 'main'
  const port = Number(env.DSH_ADMIN_PORT ?? '')
  const handoffPath = env.DSH_ADMIN_HANDOFF_PATH
  return {
    role,
    ...(Number.isFinite(port) && port > 0 ? { port } : {}),
    ...(handoffPath !== undefined && handoffPath !== '' ? { handoffPath } : {}),
  }
}

/** 向主 agent 说明看门狗与重启契约的提示文本。 */
export function watchdogPrompt(handoffPath?: string): string {
  const handoffLine =
    handoffPath !== undefined
      ? `当需要重启时：先把「重启后要自动执行的命令」写入 handoff 文件 \`${handoffPath}\`（JSON：\`{"command":"..."}\`），再触发重启；守护 DSH 会在重启后读取并执行它。`
      : '当需要重启时：先给出「重启后要自动执行的命令」，再触发重启；守护 DSH 会在重启后执行它。'
  return [
    '你由 dsh-admin 托管，是主 DSH 实例，系统中存在一个「守护 DSH」搭档，职责：',
    '1. 崩溃接管：若你崩溃，守护 DSH 会被拉起，修复会话日志并恢复同一会话续接对话，然后重启主实例。',
    '2. 重启执行：当你需要重启（例如安装或更新插件之后）时，守护 DSH 负责在重启后执行你给出的命令。',
    handoffLine,
  ].join('\n')
}

/** 本插件贡献的提示段落；导出供测试使用。 */
export function watchdogSection(runtime: RuntimeEnv): PromptSection {
  return {
    name: 'dsh-admin/watchdog',
    order: 100,
    text: watchdogPrompt(runtime.handoffPath),
  }
}

/**
 * Cordis 入口。打印解析出的环境变量；在 main 角色下注册
 * 看门狗契约系统提示段落。
 * @param ctx - Cordis 上下文。
 */
export function apply(ctx: { systemPrompt?: { section(section: PromptSection): () => void }; on?: (event: string, fn: () => void) => void }): void {
  const runtime = readRuntimeEnv()
  // eslint-disable-next-line no-console
  console.log(
    `[dsh-admin-runtime] role=${runtime.role} port=${runtime.port ?? ''} handoff=${runtime.handoffPath ?? ''}`,
  )
  if (runtime.role === 'main' && ctx.systemPrompt !== undefined) {
    const dispose = ctx.systemPrompt.section(watchdogSection(runtime))
    ctx.on?.('dispose', dispose)
  }
}
