/**
 * 桌面各模块共用的小工具：HTML 转义、字节/时间格式化、市场类型标签。
 * 先于其他桌面脚本加载，暴露 window.DshCommon 供注入或直接引用。
 */
;(function () {
  'use strict'

  /** 对不可信文本进行转义，以便插入 HTML/属性。 */
  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
  }

  /** 字节数 → 人类可读大小（未知为 —）。 */
  function fmtSize(bytes) {
    if (bytes == null) return '—'
    if (!bytes) return '0 B'
    var u = ['B', 'KB', 'MB', 'GB', 'TB']
    var i = 0
    var n = bytes
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++ }
    return (i ? n.toFixed(1) : n) + ' ' + u[i]
  }

  /** 时间戳 → 本地时间字符串。 */
  function fmtDateTime(ms) {
    return new Date(ms).toLocaleString()
  }

  var KIND_LABEL = { 'cordis-plugin': '插件', skill: '技能', 'agent-preset': '预设' }

  window.DshCommon = { esc: esc, fmtSize: fmtSize, fmtDateTime: fmtDateTime, KIND_LABEL: KIND_LABEL }
})()
