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
    if (bytes == null) return '—'
    if (!bytes) return '0 B'
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
      $('folderCount').textContent = entries.length + ' 项'
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
        // 名称过长被省略时，悬停仍可看全名。
        icon.title = e.name
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
    // 序号防串台：并发 syncAll（上传完成回调 vs 用户导航）时先发后至
    // 的响应若不丢弃，会把旧目录的条目配上新目录的路径渲染。
    var syncSeq = 0
    async function syncAll() {
      $('dshFolder').textContent = pathString() || '根目录'
      deskPathEl.textContent = deskPathLabel()
      backBtn.classList.toggle('hidden', currentPath.length === 0)
      var p = pathString()
      var seq = ++syncSeq
      // 导航/上传/刷新都会改变目录内容，全工作区搜索结果随即失效。
      if (searchMode) { searchMode = null; searchBox.value = '' }
      // 一次目录树请求同时供桌面网格和文件窗口使用。
      var r = await api('/api/desktop/tree' + (p ? '?path=' + encodeURIComponent(p) : ''))
      if (seq !== syncSeq) return
      var entries = r.ok ? (r.body.entries || []) : []
      lastEntries = entries
      renderDesktop(entries)
      renderFiles()
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
    var searchBox = $('searchBox')
    // 当前目录的原始条目（过滤/排序在渲染时按需应用）。
    var lastEntries = []
    // 列排序状态；Enter 全工作区搜索结果模式（位置无关）。
    var sortState = { key: null, dir: 1 }
    var searchMode = null // { results, hasMore }
    var ACTIONS = {
      preview: '<button class="iconbtn" data-act="preview" title="预览"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg></button>',
      download: '<button class="iconbtn" data-act="download" title="下载"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="M7 10l5 5 5-5"/><path d="M5 21h14"/></svg></button>',
      zip: '<button class="iconbtn" data-act="zip" title="打包下载 zip"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8v13H3V3h13l5 5z"/><path d="M12 3v5h5"/><path d="M10 12h2m-2 3h2m-2 3h2"/></svg></button>',
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
    /** 渲染前应用：当前目录客户端过滤（搜索框有值且不在全盘搜索模式）
     * + 列排序（名称/大小/修改时间，再点切换升降序）。 */
    function visibleEntries() {
      var list = lastEntries.slice()
      var q = searchBox.value.trim().toLowerCase()
      if (q) {
        list = list.filter(function (e) { return e.name.toLowerCase().indexOf(q) !== -1 })
      }
      if (sortState.key) {
        var key = sortState.key === 'mtime' ? 'mtimeMs' : sortState.key
        var dir = sortState.dir
        list.sort(function (a, b) {
          var r = key === 'name' ? String(a.name).localeCompare(String(b.name), 'zh-Hans-CN') : (a[key] || 0) - (b[key] || 0)
          return r * dir
        })
      }
      return list
    }
    function renderFiles() {
      var p = pathString()
      rows.innerHTML = ''
      var entries = visibleEntries()
      if (!entries.length) {
        rows.innerHTML = '<tr class="empty"><td colspan="5">' + (lastEntries.length ? '没有匹配的条目' : '此文件夹为空') + '</td></tr>'
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
          else actions += ACTIONS.zip
          actions += ACTIONS.rename + ACTIONS.move + ACTIONS.del
          rows.insertAdjacentHTML(
            'beforeend',
            '<tr data-name="' + esc(e.name) + '" data-type="' + e.type + '"><td' + nameCls + '>' + icon + esc(e.name) + '</td><td>' + (e.type === 'dir' ? '文件夹' : '文件') + '</td><td>' + fmtSize(e.size) + '</td><td>' + new Date(e.mtimeMs).toLocaleString() + '</td><td class="actions">' + actions + '</td></tr>',
          )
        }
      }
      renderBreadcrumb()
    }
    // 列头点击排序（再点同列切换方向）。
    Array.prototype.forEach.call(document.querySelectorAll('#win-files th[data-sort]'), function (th) {
      th.addEventListener('click', function () {
        var key = th.dataset.sort
        if (sortState.key === key) sortState.dir = -sortState.dir
        else sortState = { key: key, dir: 1 }
        renderFiles()
      })
    })
    // 搜索框：输入 = 过滤当前目录；Enter = 全工作区搜索；Esc = 清除。
    searchBox.addEventListener('input', function () {
      if (searchMode) { searchMode = null; searchBox.value = '' }
      renderFiles()
    })
    searchBox.addEventListener('keydown', async function (event) {
      if (event.key === 'Escape') {
        searchBox.value = ''
        searchMode = null
        renderFiles()
        return
      }
      if (event.key !== 'Enter') return
      var q = searchBox.value.trim()
      if (!q) { searchMode = null; renderFiles(); return }
      var r = await api('/api/fs/search?q=' + encodeURIComponent(q))
      if (!r.ok) { alert('搜索失败：' + r.error); return }
      searchMode = { results: r.body.results || [], hasMore: !!r.body.hasMore }
      renderSearchResults()
    })
    /** 全工作区搜索结果（路径与当前位置无关；点击目录进入、文件预览）。 */
    function renderSearchResults() {
      rows.innerHTML = ''
      var head = '搜索到 ' + searchMode.results.length + ' 项' +
        (searchMode.hasMore ? '（已达 200 项上限，请细化关键词）' : '') +
        ' <button class="btn small ghost" id="exitSearchBtn">退出搜索</button>'
      rows.insertAdjacentHTML('beforeend', '<tr class="empty"><td colspan="5">' + head + '</td></tr>')
      for (var i = 0; i < searchMode.results.length; i++) {
        var hit = searchMode.results[i]
        var icon = hit.type === 'dir'
          ? '<svg class="ficon dir" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 3h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>'
          : '<svg class="ficon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg>'
        rows.insertAdjacentHTML(
          'beforeend',
          '<tr class="search-hit" data-path="' + esc(hit.path) + '" data-type="' + hit.type + '"><td class="name-cell">' + icon + esc(hit.path) + '</td><td>' + (hit.type === 'dir' ? '文件夹' : '文件') + '</td><td>' + fmtSize(hit.size) + '</td><td>' + new Date(hit.mtimeMs).toLocaleString() + '</td><td class="actions"><button class="btn small ghost" data-open-hit="1">打开</button></td></tr>',
        )
      }
    }
    rows.addEventListener('click', async function (event) {
      // 全工作区搜索结果模式：目录进入、文件预览；退出按钮回列表。
      if (searchMode) {
        if (event.target.closest('#exitSearchBtn')) {
          searchMode = null
          searchBox.value = ''
          renderFiles()
          return
        }
        var openBtn = event.target.closest('button[data-open-hit]')
        if (openBtn) {
          var hitRow = openBtn.closest('tr.search-hit')
          if (hitRow.dataset.type === 'dir') navigate(hitRow.dataset.path)
          else openPreview(hitRow.dataset.path)
          return
        }
        return
      }
      var btn = event.target.closest('.iconbtn[data-act]')
      if (btn) {
        var tr = btn.closest('tr')
        var entryPathStr = joinPath(tr.dataset.name)
        var act = btn.dataset.act
        if (act === 'preview') openPreview(entryPathStr)
        else if (act === 'download') triggerDownload(entryPathStr)
        else if (act === 'zip') triggerZipDownload(entryPathStr)
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
          showUploadToast('已上传 ' + (body.count != null ? body.count : files.length) + ' 个文件', null)
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
    /** 文件夹打包下载（服务端流式 zip）。 */
    function triggerZipDownload(path) {
      var a = document.createElement('a')
      a.href = '/api/fs/zip?path=' + encodeURIComponent(path)
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
    var previewEdit = $('previewEdit')
    var previewSave = $('previewSave')
    var previewCancelEdit = $('previewCancelEdit')
    var previewPath = ''
    // 文本编辑态：原始内容快照 + 编辑用 textarea（保存走 /api/fs/write）。
    var editText = null
    var editArea = null
    /** 1MB 以内的未截断文本才提供在线编辑，避免大文件拖垮浏览器。 */
    var EDIT_MAX_BYTES = 1024 * 1024
    function resetEditButtons() {
      previewEdit.classList.add('hidden')
      previewSave.classList.add('hidden')
      previewCancelEdit.classList.add('hidden')
    }
    function closePreview() {
      previewModal.classList.add('hidden')
      // 清空内容，停止视频/音频播放。
      previewBody.innerHTML = ''
      previewPath = ''
      editText = null
      editArea = null
    }
    function renderTextPre(text) {
      var pre = el('pre', 'preview-text')
      pre.textContent = text
      previewBody.innerHTML = ''
      previewBody.appendChild(pre)
    }
    previewEdit.addEventListener('click', function () {
      if (editText === null) return
      editArea = el('textarea', 'preview-editor')
      editArea.value = editText
      previewBody.innerHTML = ''
      previewBody.appendChild(editArea)
      previewEdit.classList.add('hidden')
      previewSave.classList.remove('hidden')
      previewCancelEdit.classList.remove('hidden')
      editArea.focus()
    })
    previewCancelEdit.addEventListener('click', function () {
      renderTextPre(editText)
      previewEdit.classList.remove('hidden')
      previewSave.classList.add('hidden')
      previewCancelEdit.classList.add('hidden')
      editArea = null
    })
    previewSave.addEventListener('click', async function () {
      if (editArea === null || previewPath === '') return
      var btn = previewSave
      btn.disabled = true
      var r = await api('/api/fs/write', { method: 'POST', body: JSON.stringify({ path: previewPath, content: editArea.value }) })
      btn.disabled = false
      if (!r.ok) { alert('保存失败：' + (r.error === 'too_large' ? '内容超过大小上限' : r.error)); return }
      editText = editArea.value
      editArea = null
      renderTextPre(editText)
      previewEdit.classList.remove('hidden')
      previewSave.classList.add('hidden')
      previewCancelEdit.classList.add('hidden')
      syncAll()
    })
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
      resetEditButtons()
      editText = null
      editArea = null
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
      // 未截断且 ≤1MB 的文本可在线编辑（写回走 /api/fs/write 原子覆盖）。
      if (!r.body.truncated && r.body.size <= EDIT_MAX_BYTES) {
        editText = r.body.text
        previewEdit.classList.remove('hidden')
      }
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

    // ---------- 桌面图标右键菜单 ----------
    // 触屏设备不启用（部分安卓长按触发 contextmenu，与既有
    // 单击/双击/拖拽交互冲突），保留浏览器默认行为。
    var ctxMenu = $('ctxMenu')
    var ctxTarget = null // { name, type, path }
    function closeCtx() {
      ctxMenu.classList.add('hidden')
      ctxTarget = null
    }
    function openCtx(x, y, target) {
      ctxTarget = target
      // 菜单项文案按目标类型微调：目录是「打开/打包下载」，文件是「预览/下载」。
      ctxMenu.querySelector('[data-act="open"] span').textContent = target.type === 'dir' ? '打开' : '预览'
      ctxMenu.querySelector('[data-act="download"] span').textContent = target.type === 'dir' ? '打包下载 zip' : '下载'
      ctxMenu.classList.remove('hidden')
      // 先显示才能量尺寸；右/下边缘时回拉，菜单完整落在视口内。
      var r = ctxMenu.getBoundingClientRect()
      ctxMenu.style.left = Math.max(8, Math.min(x, window.innerWidth - r.width - 8)) + 'px'
      ctxMenu.style.top = Math.max(8, Math.min(y, window.innerHeight - r.height - 8)) + 'px'
    }
    if (!window.matchMedia('(pointer: coarse)').matches) {
      fileIcons.addEventListener('contextmenu', function (event) {
        var icon = event.target.closest('.desk-icon[data-name]')
        if (!icon) return
        event.preventDefault()
        openCtx(event.clientX, event.clientY, {
          name: icon.dataset.name,
          type: icon.dataset.type,
          path: joinPath(icon.dataset.name),
        })
      })
      // 五路关闭：菜单外按下 / Esc / 任意滚动 / 窗口缩放 / 点菜单项。
      document.addEventListener('pointerdown', function (event) {
        if (!ctxMenu.classList.contains('hidden') && !ctxMenu.contains(event.target)) closeCtx()
      })
      document.addEventListener('keydown', function (event) {
        if (event.key === 'Escape' && !ctxMenu.classList.contains('hidden')) closeCtx()
      })
      document.addEventListener('scroll', function () {
        if (!ctxMenu.classList.contains('hidden')) closeCtx()
      }, true)
      window.addEventListener('resize', closeCtx)
      ctxMenu.addEventListener('click', async function (event) {
        var item = event.target.closest('.ctx-item[data-act]')
        if (!item || !ctxTarget) return
        var act = item.dataset.act
        var t = ctxTarget
        closeCtx()
        if (act === 'open') {
          if (t.type === 'dir') navigate(t.path)
          else openPreview(t.path)
        } else if (act === 'rename') openRename(t.path)
        else if (act === 'move') openMove(t.path)
        else if (act === 'download') {
          if (t.type === 'dir') triggerZipDownload(t.path)
          else triggerDownload(t.path)
        } else if (act === 'delete') delEntry(t.path, t.type)
        else if (act === 'props') openProps(t)
      })
    }

    // ---------- 属性对话框 ----------
    // 信息来自当前目录条目（lastEntries 已含 size/mtimeMs），零后端改动。
    var propsDialog = $('propsDialog')
    var propsBody = $('propsBody')
    function openProps(t) {
      var e = null
      for (var i = 0; i < lastEntries.length; i++) {
        if (lastEntries[i].name === t.name) { e = lastEntries[i]; break }
      }
      var rows = [
        ['名称', t.name],
        ['类型', t.type === 'dir' ? '文件夹' : '文件'],
        ['大小', e ? fmtSize(e.size) : '—'],
        ['修改时间', e && e.mtimeMs ? new Date(e.mtimeMs).toLocaleString() : '—'],
        ['所在位置', deskPathLabel()],
      ]
      propsBody.innerHTML = ''
      for (var j = 0; j < rows.length; j++) {
        propsBody.insertAdjacentHTML('beforeend', '<dt>' + esc(rows[j][0]) + '</dt><dd>' + esc(String(rows[j][1])) + '</dd>')
      }
      propsDialog.classList.remove('hidden')
    }
    function closeProps() { propsDialog.classList.add('hidden') }
    propsDialog.addEventListener('click', function (event) { if (event.target === propsDialog) closeProps() })
    $('propsClose').addEventListener('click', closeProps)
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && !propsDialog.classList.contains('hidden')) closeProps()
    })

    return { pathString: pathString, syncAll: syncAll, navigate: navigate }
  }

  window.initFileExplorer = initFileExplorer
})()
