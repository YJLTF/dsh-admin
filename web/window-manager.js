// window-manager.js — 桌面页面的通用操作系统风格窗口管理器：
// 打开/关闭/聚焦、标题栏拖动 + 8 向缩放（指针事件）、
// 视口钳制、localStorage 几何信息持久化，以及任务栏
// 高亮同步。页面提供 `.window` / `.taskbar` 标记。
;(function () {
  'use strict'

  var STORAGE_PREFIX = 'dsh-win-'
  var MIN_W = 380
  var MIN_H = 240
  var zTop = 10
  // 各窗口按实际内容设定的默认尺寸 [宽, 高]：首次打开且无持久化
  // 几何时使用。表格列多的窗口（文件/运维/审计）偏宽，表单与
  // 状态类窗口（设置/DSH）偏紧凑，避免小内容飘在大空壳里。
  var DEFAULT_SIZE = {
    dsh: [600, 480],
    files: [800, 520],
    admin: [740, 480],
    shared: [760, 600],
    account: [600, 540],
    ops: [820, 500],
    market: [700, 600],
    audit: [780, 600],
    settings: [520, 400],
  }
  // 连续打开窗口的级联序号：位置逐步向右下偏移，避免完全重叠。
  var cascade = 0

  function winEl(id) {
    return document.getElementById('win-' + id)
  }

  function taskbarEl(id) {
    return document.querySelector('.taskbar .app[data-open="' + id + '"]')
  }

  function focusWindow(win) {
    document.querySelectorAll('.window').forEach(function (w) { w.classList.remove('focused') })
    win.classList.add('focused')
    win.style.zIndex = ++zTop
  }

  function saveWindowState(win) {
    try {
      localStorage.setItem(STORAGE_PREFIX + win.id, JSON.stringify({
        left: win.offsetLeft, top: win.offsetTop, width: win.offsetWidth, height: win.offsetHeight,
      }))
    } catch { /* 存储不可用 — 忽略 */ }
  }

  function loadWindowState(id) {
    try { return JSON.parse(localStorage.getItem(STORAGE_PREFIX + id) || 'null') } catch { return null }
  }

  function clampToViewport(left, top, win) {
    var maxLeft = Math.max(0, window.innerWidth - win.offsetWidth)
    var maxTop = Math.max(0, window.innerHeight - win.offsetHeight)
    return {
      left: Math.min(Math.max(left, 0), maxLeft),
      top: Math.min(Math.max(top, 0), maxTop),
    }
  }

  function positionWindow(win) {
    if (win.dataset.placed) return
    win.dataset.placed = '1'
    var saved = loadWindowState(win.id)
    var def = DEFAULT_SIZE[win.id.replace(/^win-/, '')] || [620, 460]
    // 尺寸先设定再钳制位置：clampToViewport 依赖 offsetWidth/Height，
    // 顺序颠倒会用内容自适应尺寸而非最终尺寸计算边界。
    // 持久化几何可能来自更大的屏幕，先钳到当前视口内。
    var w = Math.min(saved && saved.width ? saved.width : def[0], window.innerWidth - 24)
    var h = Math.min(saved && saved.height ? saved.height : def[1], window.innerHeight - 24)
    win.style.width = w + 'px'
    win.style.height = h + 'px'
    var step = (cascade++ % 5)
    var left = saved ? saved.left : Math.round((window.innerWidth - w) / 2) + step * 28
    var top = saved ? saved.top : Math.round((window.innerHeight - h) / 2) + step * 24
    var pos = clampToViewport(left, top, win)
    win.style.left = pos.left + 'px'
    win.style.top = pos.top + 'px'
  }

  function syncTaskbar(id, open) {
    var task = taskbarEl(id)
    if (task) task.classList.toggle('active', open)
  }

  function openWindow(id) {
    var win = winEl(id)
    if (!win) return
    if (win.classList.contains('hidden')) {
      win.classList.remove('hidden')
      positionWindow(win)
    }
    focusWindow(win)
    syncTaskbar(id, true)
  }

  function closeWindow(id) {
    var win = winEl(id)
    if (!win) return
    win.classList.add('hidden')
    syncTaskbar(id, false)
  }

  function isOpen(id) {
    var win = winEl(id)
    return !!win && !win.classList.contains('hidden')
  }

  function startResize(win, e, dir) {
    e.stopPropagation()
    focusWindow(win)
    var sx = e.clientX, sy = e.clientY
    var r = win.getBoundingClientRect()
    var start = { left: r.left, top: r.top, width: win.offsetWidth, height: win.offsetHeight }
    var L = dir.indexOf('w') !== -1, R = dir.indexOf('e') !== -1
    var T = dir.indexOf('n') !== -1, B = dir.indexOf('s') !== -1
    function move(ev) {
      var dx = ev.clientX - sx, dy = ev.clientY - sy
      var left = start.left, top = start.top, width = start.width, height = start.height
      if (R) width = Math.max(MIN_W, start.width + dx)
      if (L) { width = Math.max(MIN_W, start.width - dx); left = start.left + (start.width - width) }
      if (B) height = Math.max(MIN_H, start.height + dy)
      if (T) { height = Math.max(MIN_H, start.height - dy); top = start.top + (start.height - height) }
      win.style.left = left + 'px'
      win.style.top = top + 'px'
      win.style.width = width + 'px'
      win.style.height = height + 'px'
    }
    function up() {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      saveWindowState(win)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  // 触屏设备：窗口全屏显示（CSS），无需拖动/缩放。
  var TOUCH = window.matchMedia('(pointer: coarse)').matches
  if (!TOUCH) {
    document.querySelectorAll('.window-title').forEach(function (bar) {
      bar.addEventListener('pointerdown', function (e) {
        var win = bar.closest('.window')
        focusWindow(win)
        if (e.target.closest('button')) return
        var sx = e.clientX, sy = e.clientY, l = win.offsetLeft, t = win.offsetTop
        function move(ev) {
          var pos = clampToViewport(l + (ev.clientX - sx), t + (ev.clientY - sy), win)
          win.style.left = pos.left + 'px'
          win.style.top = pos.top + 'px'
        }
        function up() {
          window.removeEventListener('pointermove', move)
          window.removeEventListener('pointerup', up)
          saveWindowState(win)
        }
        window.addEventListener('pointermove', move)
        window.addEventListener('pointerup', up)
      })
    })
    document.querySelectorAll('.window').forEach(function (win) {
      ;['n', 's', 'e', 'w', 'ne', 'nw', 'sw'].forEach(function (d) {
        var h = document.createElement('div')
        h.className = 'rz rz-' + d
        h.title = '拖动缩放'
        h.addEventListener('pointerdown', function (e) { startResize(win, e, d) })
        win.appendChild(h)
      })
    })
    document.querySelectorAll('.window .resize').forEach(function (rz) {
      rz.addEventListener('pointerdown', function (e) { startResize(rz.closest('.window'), e, 'se') })
    })
  }
  document.querySelectorAll('.window').forEach(function (w) {
    w.addEventListener('pointerdown', function () { focusWindow(w) })
  })

  // 从桌面图标和任务栏打开应用（单击）。
  document.querySelectorAll('[data-open]').forEach(function (el) {
    el.addEventListener('click', function () { openWindow(el.dataset.open) })
  })

  // 为以 div 渲染的图标/任务栏项提供键盘激活。
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter' && e.key !== ' ') return
    var el = e.target.closest ? e.target.closest('[data-open]') : null
    if (el) {
      e.preventDefault()
      openWindow(el.dataset.open)
    }
  })

  window.WindowManager = { openWindow: openWindow, closeWindow: closeWindow, isOpen: isOpen }
})()
