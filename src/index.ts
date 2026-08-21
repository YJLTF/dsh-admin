/**
 * Cordis 入口，仅用于插件市场识别。
 *
 * 真正的产品是独立的 `dsh-admin` 可执行程序（见 `./cli.js`），
 * 它运行自己的 Fastify 服务器并为每个用户拉起各自的 DSH 进程。此处的
 * `apply` 是受保护的无操作（no-op）：把本包加载进任何 profile 都不得
 * 启动服务器。
 * @module dsh-admin
 */

export const name = 'dsh-admin'

/** 由 Cordis 加载器读取的选项。`serve` 为预留项，尚未实现。 */
export interface Config {
  serve?: boolean
}

/**
 * 受保护的无操作垫片。保持零副作用，以确保插件市场安装和普通
 * profile 不会意外启动编排器。
 * @param _ctx - Cordis 上下文（未使用）。
 * @param _config - 加载器传入的配置（未使用）。
 */
export function apply(_ctx?: unknown, _config?: Config): void {
  // 刻意留空。
}
