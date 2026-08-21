/**
 * 文件资源管理器：桌面网格 + 「我的文件」窗口 + 预览 / 重命名 / 移动
 * 对话框 + multipart 上传（含文件夹、进度）。从 desktop.html 的内联
 * 脚本抽出，经 initFileExplorer({ api, esc }) 注入依赖，返回
 * { pathString, syncAll, navigate } 供 DSH 启动等桌面逻辑复用。
 */
;(function () {
  'use strict'

  /** 常见扩展名 → 预览形态。未命中者先按文本尝试（服务端会拒绝
   * 二进制并返回 415，届时降级为信息面板 + 下载）。 */
  var IMG_EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif', 'svg']
  var VIDEO_EXT = ['mp4', 'webm', 'm4v', 'mov']
  var AUDIO_EXT = ['mp3', 'm4a', 'aac', 'wav', 'ogg', 'oga', 'flac']
  var PDF_EXT = ['pdf']

  function extOf(name) {
    var i = name.lastIndexOf('.')
    return i === -1 ? '' : name.slice(i + 1).toLowerCase()
  }
  function previewKind(name) {
    var e = extOf(name)
    if (IMG_EXT.indexOf(e) !== -1) return 'image'
    if (VIDEO_EXT.indexOf(e) !== -1) return 'video'
    if (AUDIO_EXT.indexOf(e) !== -1) return 'audio'
    if (PDF_EXT.indexOf(e) !== -1) return 'pdf'
    return 'text'
  }
  function fmtSize(bytes) {
    if (!bytes) return '—'
    var u = ['B', 'KB', 'MB', 'GB']
    var i = 0
    var n = bytes
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++ }
    return (i ? n.toFixed(1) : n) + ' ' + u[i]
  }
  function nameOf(path) { return path.split('/').pop() }
  function rawUrl(path, download) {
    return '/api/fs/raw?path=' + encodeURIComponent(path) + (download ? '&download=1' : '')
  }

  function initFileExplorer(ctx) {
    var api = ctx.api
    var esc = ctx.esc
    var $ = function (id) { return document.getElementById(id) }

    // ---------- 路径状态（桌面网格与文件窗口共享） ----------
    var currentPath = []
    function pathString() { return currentPath.join('/') }
    function joinPath(name) { return pathString() ? pathString() + '/' + name : name }
    function deskPathLabel() {
      return currentPath.length ? '我的桌面 / ' + currentPath.join(' / ') : '我的桌面 / 根目录'
    }

    // ---------- 桌面文件网格 ----------
    var fileIcons = $('fileIcons')
    var deskPathEl = $('deskPath')
    var backBtn = $('backBtn')
    var TILE_DIR = '<div class="tile files"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 3h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg></div>'
    var TILE_FILE = '<div class="tile file"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg></div>'
    function renderDesktop(entries) {
      fileIcons.innerHTML = ''
      if (!entries.length) {
        fileIcons.innerHTML = '<p class="desk-empty">此文件夹为空</p>'
        return
      }
      for (var i = 0; i < entries.length; i++) {
        var e = entries[i]
        var icon = document.createElement('div')
        icon.className = 'desk-icon'
        icon.dataset.type = e.type
        icon.dataset.name = e.name
        icon.setAttribute('role', 'button')
        icon.setAttribute('tabindex', '0')
        icon.draggable = true
        icon.innerHTML = (e.type === 'dir' ? TILE_DIR : TILE_FILE) + '<span class="label">' + esc(e.name) + '</span>'
        fileIcons.appendChild(icon)
      }
    }
    // 双击：目录进入、文件预览。
    fileIcons.addEventListener('dblclick', function (event) {
      var icon = event.target.closest('.desk-icon[data-type]')
      if (!icon) return
      if (icon.dataset.type === 'dir') navigate(joinPath(icon.dataset.name))
      else openPreview(joinPath(icon.dataset.name))
    })

    // ---------- 桌面图标拖拽：移动到文件夹 ----------
    var dragSrc = null
    function clearDropHighlight() {
      fileIcons.querySelectorAll('.drop-target').forEach(function (el) { el.classList.remove('drop-target') })
    }
    fileIcons.addEventListener('dragstart', function (event) {
      var icon = event.target.closest('.desk-icon[data-name]')
      if (!icon) return
      dragSrc = { name: icon.dataset.name, type: icon.dataset.type }
      icon.classList.add('dragging')
      event.dataTransfer.effectAllowed = 'move'
      try { event.dataTransfer.setData('text/plain', icon.dataset.name) } catch (e) { /* 旧浏览器无伤大雅 */ }
    })
    // 悬停到有效目标（文件夹、非自身）时才放行 drop 并高亮。
    fileIcons.addEventListener('dragover', function (event) {
      if (!dragSrc) return
      var icon = event.target.closest('.desk-icon[data-name]')
      var valid = icon !== null && icon.dataset.type === 'dir' && icon.dataset.name !== dragSrc.name
      clearDropHighlight()
      if (!valid) {
        event.dataTransfer.dropEffect = 'none'
        return
      }
      event.preventDefault()
      event.dataTransfer.dropEffect = 'move'
      icon.classList.add('drop-target')
    })
    // 只有整体离开网格才清高亮；图标之间的子元素切换交给 dragover 重算。
    fileIcons.addEventListener('dragleave', function (event) {
      if (!event.relatedTarget || !fileIcons.contains(event.relatedTarget)) clearDropHighlight()
    })
    fileIcons.addEventListener('drop', async function (event) {
      event.preventDefault()
      clearDropHighlight()
      var icon = event.target.closest('.desk-icon[data-name]')
      if (!dragSrc || !icon || icon.dataset.type !== 'dir' || icon.dataset.name === dragSrc.name) return
      await moveEntry(joinPath(dragSrc.name), joinPath(icon.dataset.name))
      dragSrc = null
    })
    // 无论 drop 成败/取消都会触发 dragend，统一清理。
    fileIcons.addEventListener('dragend', function () {
      dragSrc = null
      clearDropHighlight()
      fileIcons.querySelectorAll('.dragging').forEach(function (el) { el.classList.remove('dragging') })
    })

    // ---------- 同步桌面 + 文件窗口 ----------
    async function syncAll() {
      $('dshFolder').textContent = pathString() || '根目录'
      deskPathEl.textContent = deskPathLabel()
      backBtn.classList.toggle('hidden', currentPath.length === 0)
      var p = pathString()
      // 一次目录树请求同时供桌面网格和文件窗口使用。
      var r = await api('/api/desktop/tree' + (p ? '?path=' + encodeURIComponent(p) : ''))
      var entries = r.ok ? (r.body.entries || []) : []
      renderDesktop(entries)
      renderFiles(entries)
    }
    async function navigate(path) {
      currentPath = path ? path.split('/').filter(Boolean) : []
      await syncAll()
    }
    backBtn.addEventListener('click', function () {
      currentPath = currentPath.slice(0, -1)
      syncAll()
    })

    // ---------- 文件窗口（表格 + 工具栏） ----------
    var rows = $('rows')
    var breadcrumb = $('breadcrumb')
    var ACTIONS = {
      preview: '<button class="iconbtn" data-act="preview" title="预览"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg></button>',
      download: '<button class="iconbtn" data-act="download" title="下载"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="M7 10l5 5 5-5"/><path d="M5 21h14"/></svg></button>',
      rename: '<button class="iconbtn" data-act="rename" title="重命名"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z"/></svg></button>',
      move: '<button class="iconbtn" data-act="move" title="移动到…"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="M13 6l6 6-6 6"/></svg></button>',
      del: '<button class="iconbtn danger" data-act="del" title="删除"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg></button>',
    }
    function renderBreadcrumb() {
      var parts = ['<span class="crumb" data-path="">根</span>']
      var acc = []
      for (var i = 0; i < currentPath.length; i++) {
        acc.push(currentPath[i])
        parts.push('<span class="sep">/</span><span class="crumb" data-path="' + esc(acc.join('/')) + '">' + esc(currentPath[i]) + '</span>')
      }
      breadcrumb.innerHTML = parts.join('')
    }
    function renderFiles(entries) {
      var p = pathString()
      rows.innerHTML = ''
      if (!entries.length) {
        rows.innerHTML = '<tr class="empty"><td colspan="5">此文件夹为空</td></tr>'
      } else {
        if (p) rows.insertAdjacentHTML('beforeend', '<tr><td class="dir" data-up="1">..</td><td></td><td></td><td></td><td></td></tr>')
        for (var i = 0; i < entries.length; i++) {
          var e = entries[i]
          var icon = e.type === 'dir'
            ? '<svg class="ficon dir" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 3h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>'
            : '<svg class="ficon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg>'
          var nameCls = e.type === 'dir'
            ? ' class="name-cell dir" data-name="' + esc(e.name) + '"'
            : ' class="name-cell" data-name="' + esc(e.name) + '"'
          var actions = ''
          if (e.type === 'file') actions += ACTIONS.preview + ACTIONS.download
          actions += ACTIONS.rename + ACTIONS.move + ACTIONS.del
          rows.insertAdjacentHTML(
            'beforeend',
            '<tr data-name="' + esc(e.name) + '" data-type="' + e.type + '"><td' + nameCls + '>' + icon + esc(e.name) + '</td><td>' + (e.type === 'dir' ? '文件夹' : '文件') + '</td><td>' + fmtSize(e.size) + '</td><td>' + new Date(e.mtimeMs).toLocaleString() + '</td><td class="actions">' + actions + '</td></tr>',
          )
        }
      }
      renderBreadcrumb()
    }
    rows.addEventListener('click', async function (event) {
      var btn = event.target.closest('.iconbtn[data-act]')
      if (btn) {
        var tr = btn.closest('tr')
        var entryPathStr = joinPath(tr.dataset.name)
        var act = btn.dataset.act
        if (act === 'preview') openPreview(entryPathStr)
        else if (act === 'download') triggerDownload(entryPathStr)
        else if (act === 'rename') openRename(entryPathStr)
        else if (act === 'move') openMove(entryPathStr)
        else if (act === 'del') delEntry(entryPathStr, tr.dataset.type)
        return
      }
      var dir = event.target.closest('.dir[data-name]')
      if (dir) { navigate(joinPath(dir.dataset.name)); return }
      if (event.target.closest('.dir[data-up]')) {
        currentPath = currentPath.slice(0, -1)
        syncAll()
      }
    })
    // 双击文件名预览；目录的进入沿用单击（上方 click 委托），
    // 双击若再导航会叠成「docs/docs」。
    rows.addEventListener('dblclick', function (event) {
      var td = event.target.closest('td[data-name]')
      if (!td) return
      var tr = td.closest('tr')
      if (tr.dataset.type !== 'file') return
      openPreview(joinPath(tr.dataset.name))
    })
    breadcrumb.addEventListener('click', function (event) {
      var crumb = event.target.closest('.crumb')
      if (crumb) navigate(crumb.dataset.path)
    })

    // ---------- 工具栏 / 新建对话框 ----------
    var dialog = $('newFileDialog')
    var nfName = $('nfName')
    var nfType = $('nfType')
    var nfTitle = $('nfTitle')
    function openDialog(type) {
      nfType.value = type
      nfTitle.textContent = type === 'dir' ? '新建文件夹' : '新建文件'
      dialog.classList.remove('hidden')
      nfName.value = ''
      nfName.focus()
    }
    function closeDialog() { dialog.classList.add('hidden') }
    dialog.addEventListener('click', function (event) { if (event.target === dialog) closeDialog() })
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && !dialog.classList.contains('hidden')) closeDialog()
    })
    $('nfOk').addEventListener('click', async function () {
      var name = nfName.value.trim()
      if (!name) { alert('请输入名称'); return }
      var r = await api('/api/fs/create', { method: 'POST', body: JSON.stringify({ path: pathString(), name: name, type: nfType.value }) })
      if (!r.ok) { alert(r.error === 'exists' ? '已有同名文件/文件夹' : '创建失败：' + r.error); return }
      closeDialog()
      syncAll()
    })
    $('nfName').addEventListener('keydown', function (event) { if (event.key === 'Enter') $('nfOk').click() })
    $('nfCancel').addEventListener('click', closeDialog)

    // 桌面图标 / 任务栏的应用型按钮（上传、新建、刷新）。
    function appAction(app) {
      if (app === 'upload') $('fileInput').click()
      else if (app === 'uploaddir') $('folderInput').click()
      else if (app === 'newfile') openDialog('file')
      else if (app === 'newdir') openDialog('dir')
      else if (app === 'refresh') syncAll()
    }
    document.querySelectorAll('[data-app]').forEach(function (el) {
      el.addEventListener('click', function () { appAction(el.dataset.app) })
    })
    document.addEventListener('keydown', function (event) {
      if (event.key !== 'Enter' && event.key !== ' ') return
      var el = event.target.closest ? event.target.closest('[data-app]') : null
      if (el) {
        event.preventDefault()
        appAction(el.dataset.app)
      }
    })

    // ---------- 上传（multipart + 进度） ----------
    var uploadToast = $('uploadToast')
    var uploadToastText = $('uploadToastText')
    var uploadToastFill = $('uploadToastFill')
    var toastTimer = null
    function showUploadToast(text, fraction) {
      uploadToastText.textContent = text
      uploadToastFill.style.width = fraction === null ? '100%' : Math.round(fraction * 100) + '%'
      uploadToast.classList.remove('hidden')
      uploadToast.classList.toggle('done', fraction === null)
      if (toastTimer) { clearTimeout(toastTimer); toastTimer = null }
    }
    function hideUploadToastLater() {
      toastTimer = setTimeout(function () { uploadToast.classList.add('hidden') }, 2600)
    }
    function uploadFileList(fileList) {
      var files = Array.prototype.slice.call(fileList)
      if (!files.length) return
      var fd = new FormData()
      fd.append('path', pathString())
      for (var i = 0; i < files.length; i++) {
        // webkitRelativePath 保留文件夹结构（服务端逐段净化）。
        var rel = files[i].webkitRelativePath || files[i].name
        fd.append('files', files[i], rel)
      }
      var label = files.length === 1 ? files[0].name : files[0].name + ' 等 ' + files.length + ' 个文件'
      var xhr = new XMLHttpRequest()
      xhr.open('POST', '/api/fs/upload')
      xhr.responseType = 'json'
      xhr.upload.onprogress = function (e) {
        if (e.lengthComputable) showUploadToast('上传中：' + label, e.loaded / e.total)
      }
      xhr.onload = function () {
        var body = xhr.response || {}
        if (xhr.status === 200) {
          showUploadToast('已上传 ' + (body.count || files.length) + ' 个文件', null)
          hideUploadToastLater()
          syncAll()
        } else {
          var errMap = { too_large: '文件超过大小上限', bad_name: '文件名不合法', bad_path: '目标路径不合法' }
          showUploadToast('上传失败：' + (errMap[body.error] || body.error || xhr.status), null)
          hideUploadToastLater()
        }
      }
      xhr.onerror = function () {
        showUploadToast('上传失败：网络错误', null)
        hideUploadToastLater()
      }
      showUploadToast('上传中：' + label, 0)
      xhr.send(fd)
    }
    $('fileInput').addEventListener('change', function (event) {
      uploadFileList(event.target.files)
      event.target.value = ''
    })
    $('folderInput').addEventListener('change', function (event) {
      uploadFileList(event.target.files)
      event.target.value = ''
    })

    // ---------- 删除 ----------
    async function delEntry(path, type) {
      var name = nameOf(path)
      var msg = type === 'dir' ? '删除文件夹「' + name + '」及其全部内容？此操作不可恢复。' : '删除文件「' + name + '」？'
      if (!window.confirm(msg)) return
      var r = await api('/api/fs/delete', { method: 'POST', body: JSON.stringify({ path: path }) })
      if (!r.ok) { alert('删除失败：' + r.error); return }
      syncAll()
    }

    // ---------- 下载 ----------
    function triggerDownload(path) {
      var a = document.createElement('a')
      a.href = rawUrl(path, true)
      a.download = ''
      document.body.appendChild(a)
      a.click()
      a.remove()
    }

    // ---------- 重命名对话框 ----------
    var renameDialog = $('renameDialog')
    var rnName = $('rnName')
    var rnPath = ''
    function openRename(path) {
      rnPath = path
      rnName.value = nameOf(path)
      renameDialog.classList.remove('hidden')
      rnName.focus()
      rnName.select()
    }
    function closeRename() { renameDialog.classList.add('hidden') }
    renameDialog.addEventListener('click', function (event) { if (event.target === renameDialog) closeRename() })
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && !renameDialog.classList.contains('hidden')) closeRename()
    })
    $('rnOk').addEventListener('click', async function () {
      var name = rnName.value.trim()
      if (!name) { alert('请输入名称'); return }
      var r = await api('/api/fs/rename', { method: 'POST', body: JSON.stringify({ path: rnPath, name: name }) })
      if (!r.ok) { alert(r.error === 'exists' ? '已有同名文件/文件夹' : '重命名失败：' + r.error); return }
      closeRename()
      syncAll()
    })
    rnName.addEventListener('keydown', function (event) { if (event.key === 'Enter') $('rnOk').click() })
    $('rnCancel').addEventListener('click', closeRename)

    // ---------- 移动对话框 ----------
    var moveDialog = $('moveDialog')
    var moveCrumbs = $('moveCrumbs')
    var moveDirs = $('moveDirs')
    var moveHereBtn = $('moveHereBtn')
    var moveSrc = ''
    var moveTarget = []
    function openMove(path) {
      moveSrc = path
      moveTarget = pathString() ? pathString().split('/') : []
      moveDialog.classList.remove('hidden')
      renderMoveDialog()
    }
    function closeMove() { moveDialog.classList.add('hidden') }
    moveDialog.addEventListener('click', function (event) { if (event.target === moveDialog) closeMove() })
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && !moveDialog.classList.contains('hidden')) closeMove()
    })
    async function renderMoveDialog() {
      var p = moveTarget.join('/')
      moveHereBtn.disabled = true
      var parts = ['<span class="crumb" data-path="">根</span>']
      var acc = []
      for (var i = 0; i < moveTarget.length; i++) {
        acc.push(moveTarget[i])
        parts.push('<span class="sep">/</span><span class="crumb" data-path="' + esc(acc.join('/')) + '">' + esc(moveTarget[i]) + '</span>')
      }
      moveCrumbs.innerHTML = parts.join('')
      var r = await api('/api/desktop/tree' + (p ? '?path=' + encodeURIComponent(p) : ''))
      moveDirs.innerHTML = ''
      if (!r.ok) {
        moveDirs.innerHTML = '<p class="hint">无法读取该目录：' + esc(r.error) + '</p>'
        return
      }
      var dirs = (r.body.entries || []).filter(function (e) { return e.type === 'dir' })
      if (!dirs.length) {
        moveDirs.innerHTML = '<p class="hint">此目录下没有子文件夹</p>'
      } else {
        for (var j = 0; j < dirs.length; j++) {
          moveDirs.insertAdjacentHTML('beforeend', '<div class="move-dir-item" data-name="' + esc(dirs[j].name) + '"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 3h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>' + esc(dirs[j].name) + '</div>')
        }
      }
      // 目标不能是源本身或源的子目录（服务端同样强制）。
      var targetStr = moveTarget.join('/')
      moveHereBtn.disabled = targetStr === moveSrc || moveSrc.indexOf(targetStr + '/') === 0
    }
    moveCrumbs.addEventListener('click', function (event) {
      var crumb = event.target.closest('.crumb')
      if (crumb) {
        moveTarget = crumb.dataset.path ? crumb.dataset.path.split('/') : []
        renderMoveDialog()
      }
    })
    moveDirs.addEventListener('click', function (event) {
      var item = event.target.closest('.move-dir-item')
      if (item) {
        moveTarget.push(item.dataset.name)
        renderMoveDialog()
      }
    })
    $('moveUpBtn').addEventListener('click', function () {
      moveTarget = moveTarget.slice(0, -1)
      renderMoveDialog()
    })
    /** 移动一个条目（移动对话框与桌面拖拽共用）；成功后刷新列表。 */
    async function moveEntry(src, dest) {
      // 目标在源内部（含源自身）造环，提前给出友好提示（服务端同样强制）。
      if (dest === src || dest.indexOf(src + '/') === 0) {
        alert('不能移动到自身内部')
        return false
      }
      var r = await api('/api/fs/move', { method: 'POST', body: JSON.stringify({ path: src, dest: dest }) })
      if (!r.ok) { alert(r.error === 'exists' ? '目标位置已有同名文件/文件夹' : '移动失败：' + r.error); return false }
      syncAll()
      return true
    }

    moveHereBtn.addEventListener('click', async function () {
      if (await moveEntry(moveSrc, moveTarget.join('/'))) closeMove()
    })
    $('moveCancelBtn').addEventListener('click', closeMove)

    // ---------- 预览对话框 ----------
    var previewModal = $('previewModal')
    var previewTitle = $('previewTitle')
    var previewBody = $('previewBody')
    var previewDownload = $('previewDownload')
    var previewPath = ''
    function closePreview() {
      previewModal.classList.add('hidden')
      // 清空内容，停止视频/音频播放。
      previewBody.innerHTML = ''
      previewPath = ''
    }
    previewModal.addEventListener('click', function (event) { if (event.target === previewModal) closePreview() })
    $('previewCloseBtn').addEventListener('click', closePreview)
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && !previewModal.classList.contains('hidden')) closePreview()
    })
    function el(tag, cls, text) {
      var node = document.createElement(tag)
      if (cls) node.className = cls
      if (text !== undefined) node.textContent = text
      return node
    }
    async function openPreview(path) {
      previewPath = path
      var name = nameOf(path)
      previewTitle.textContent = name
      previewBody.innerHTML = ''
      previewModal.classList.remove('hidden')
      previewDownload.classList.add('hidden')
      var kind = previewKind(name)
      var url = rawUrl(path, false)
      if (kind === 'image') {
        var img = el('img')
        img.src = url
        img.alt = name
        img.onerror = function () { previewBody.innerHTML = ''; renderBinaryInfo(name) }
        previewBody.appendChild(img)
        previewDownload.classList.remove('hidden')
        return
      }
      if (kind === 'video') {
        var video = el('video')
        video.controls = true
        video.preload = 'metadata'
        video.src = url
        previewBody.appendChild(video)
        previewDownload.classList.remove('hidden')
        return
      }
      if (kind === 'audio') {
        var audio = el('audio')
        audio.controls = true
        audio.src = url
        previewBody.appendChild(el('div', 'preview-audio-name', name))
        previewBody.appendChild(audio)
        previewDownload.classList.remove('hidden')
        return
      }
      if (kind === 'pdf') {
        var iframe = el('iframe')
        iframe.src = url
        iframe.title = name
        previewBody.appendChild(iframe)
        previewDownload.classList.remove('hidden')
        return
      }
      // 文本（或未知类型先尝试文本，415 时降级）。
      var r = await api('/api/fs/read?path=' + encodeURIComponent(path))
      if (!r.ok) {
        if (r.status === 415) {
          renderBinaryInfo(name)
          previewDownload.classList.remove('hidden')
        } else {
          previewBody.appendChild(el('p', 'hint', '无法读取：' + (r.error || r.status)))
        }
        return
      }
      if (r.body.truncated) {
        previewBody.appendChild(el('p', 'hint', '文件较大，仅显示前 ' + fmtSize(256 * 1024) + '。'))
      }
      var pre = el('pre', 'preview-text')
      pre.textContent = r.body.text
      previewBody.appendChild(pre)
      previewDownload.classList.remove('hidden')
    }
    function renderBinaryInfo(name) {
      var info = el('div', 'preview-binary')
      info.appendChild(el('div', 'preview-binary-name', name))
      info.appendChild(el('div', 'hint', '此文件类型不支持在线预览，可下载后查看。'))
      previewBody.appendChild(info)
    }
    previewDownload.addEventListener('click', function () {
      if (previewPath) triggerDownload(previewPath)
    })

    return { pathString: pathString, syncAll: syncAll, navigate: navigate }
  }

  window.initFileExplorer = initFileExplorer
})()
