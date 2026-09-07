/**
 * 管理员扩展窗口：运维监控（实例 + 磁盘）、审计日志（分页/筛选）、
 * 系统设置（注册开关/邀请码）、插件市场管理（导入/删除）。
 * 经 initAdminExtras({ api, esc }) 注入依赖，返回各窗口的加载函数。
 */
;(function () {
  'use strict'

  var DshCommon = window.DshCommon
  var fmtSize = DshCommon.fmtSize
  var fmtDateTime = DshCommon.fmtDateTime
  var truncate = DshCommon.truncate
  var KIND_LABEL = DshCommon.KIND_LABEL
  var STATE_LABEL = DshCommon.STATE_LABEL

  function fmtUptime(fromMs) {
    var s = Math.max(0, Math.floor((Date.now() - fromMs) / 1000))
    if (s < 60) return s + ' 秒'
    var m = Math.floor(s / 60)
    if (m < 60) return m + ' 分钟'
    var h = Math.floor(m / 60)
    if (h < 24) return h + ' 小时 ' + (m % 60) + ' 分'
    return Math.floor(h / 24) + ' 天 ' + (h % 24) + ' 小时'
  }

  function initAdminExtras(ctx) {
    var api = ctx.api
    var esc = ctx.esc

    // ---------- 运维监控 ----------
    async function loadOps() {
      var tbody = document.querySelector('#opsInstances tbody')
      var r = await api('/api/admin/instances')
      if (!r.ok) { tbody.innerHTML = DshCommon.emptyRow(7, '加载失败'); return }
      document.getElementById('opsDshVersion').textContent = r.body.dshVersion || '版本未知'
      tbody.innerHTML = ''
      if (!r.body.instances.length) {
        tbody.innerHTML = DshCommon.emptyRow(7, '当前没有运行中的实例')
      } else {
        for (var i = 0; i < r.body.instances.length; i++) {
          var inst = r.body.instances[i]
          var stopBtn = inst.status === 'starting' || inst.status === 'running'
            ? '<button class="btn small danger" data-stop="' + esc(inst.userId) + '" data-name="' + esc(inst.username) + '">停止</button>'
            : '<span class="hint">—</span>'
          tbody.insertAdjacentHTML(
            'beforeend',
            '<tr><td>' + esc(inst.username) + '</td><td>' + (inst.role === 'main' ? '主实例' : '看门狗') + '</td><td>' + (STATE_LABEL[inst.status] || esc(inst.status)) + '</td><td>' + (inst.port != null ? inst.port : '—') + '</td><td>' + fmtUptime(inst.startedAt) + '</td><td>' + (inst.restarts || 0) + '</td><td>' + stopBtn + '</td></tr>',
          )
        }
      }
      loadStorage(false)
    }
    document.querySelector('#opsInstances tbody').addEventListener('click', async function (event) {
      var btn = event.target.closest('button[data-stop]')
      if (!btn) return
      if (!window.confirm('停止用户「' + btn.dataset.name + '」的 DSH 实例？（账号不受影响，用户可自行重新启动）')) return
      var r = await api('/api/admin/instances/' + encodeURIComponent(btn.dataset.stop) + '/stop', { method: 'POST' })
      if (!r.ok) alert('停止失败：' + (r.error === 'not_running' ? '实例已不在运行' : r.error))
      await loadOps()
    })
    async function loadStorage(refresh) {
      var tbody = document.querySelector('#opsStorage tbody')
      tbody.innerHTML = DshCommon.emptyRow(4, '统计中…（首次全量扫描可能较慢）')
      var r = await api('/api/admin/storage' + (refresh ? '?refresh=1' : ''))
      if (!r.ok) { tbody.innerHTML = DshCommon.emptyRow(4, '加载失败'); return }
      tbody.innerHTML = ''
      for (var i = 0; i < r.body.users.length; i++) {
        var u = r.body.users[i]
        tbody.insertAdjacentHTML('beforeend', '<tr><td>' + esc(u.username) + '</td><td>' + fmtSize(u.homeBytes) + '</td><td>' + fmtSize(u.wsBytes) + '</td><td>' + fmtSize(u.totalBytes) + '</td></tr>')
      }
      if (!r.body.users.length) tbody.innerHTML = DshCommon.emptyRow(4, '暂无用户')
      document.getElementById('opsStorageMeta').textContent = '合计 ' + fmtSize(r.body.totalBytes) + '（' + fmtDateTime(r.body.computedAt) + ' 统计，缓存 60 秒）'
    }
    document.getElementById('opsStorageRefresh').addEventListener('click', function () { loadStorage(true) })

    // ---------- dsh CLI 热更新 ----------
    async function loadCli() {
      var hint = document.getElementById('cliUpdateHint')
      var row = document.getElementById('cliUpdateRow')
      var r = await api('/api/admin/dsh-cli')
      if (!r.ok) { hint.textContent = 'dsh CLI 状态加载失败'; return }
      if (!r.body.managed) {
        hint.textContent = '未配置 DSH_ADMIN_DSH_CLI_DIR，平台不管 CLI 更新（可按部署文档手工解压 dsh-cli.tgz）。'
        row.classList.add('hidden')
        return
      }
      row.classList.remove('hidden')
      var installed = r.body.installedVersion || '未知'
      var running = r.body.runningVersion || '未知'
      hint.textContent = '目录 ' + r.body.cliDir + ' · 已安装 v' + installed + ' · 运行探测 v' + running +
        (installed !== running ? '（存在已落盘未生效的更新：运行中实例仍是旧版，新会话即用新版）' : '')
    }
    void loadCli()
    document.getElementById('dshCliUpdateBtn').addEventListener('click', function (event) {
      var input = document.getElementById('dshCliTgz')
      var file = input.files && input.files[0]
      if (!file) {
        DshCommon.setMsg('dshCliMsg', '请先选择 scripts/pack-dsh.ps1 产出的 dsh-cli.tgz', true)
        return
      }
      var fd = new FormData()
      fd.append('file', file, file.name)
      void DshCommon.uploadForm('/api/admin/dsh-cli/update', fd, {
        btn: event.currentTarget,
        msg: 'dshCliMsg',
        busyText: '更新中（解包校验并替换 node_modules）…',
        failText: '更新失败',
        onOk: async function (body) {
          DshCommon.setMsg('dshCliMsg',
            '已更新：v' + (body.previousVersion || '未知') + ' → v' + body.newVersion +
            '。新启动的会话即用新版' + (body.runningUserIds && body.runningUserIds.length ? '；当前有 ' + body.runningUserIds.length + ' 个运行中实例仍用旧版，可点「停止全部运行实例」促使用户重启。' : '。'))
          input.value = ''
          await Promise.all([loadCli(), loadOps()])
        },
      })
    })
    document.getElementById('stopAllBtn').addEventListener('click', async function () {
      if (!window.confirm('停止全部运行中的 DSH 实例？（账号不受影响，用户可自行重新启动）')) return
      var r = await api('/api/admin/instances/stop-all', { method: 'POST' })
      if (!r.ok) alert('停止失败：' + r.error)
      await loadOps()
    })

    // ---------- 审计日志 ----------
    var auditPage = 1
    var auditLimit = 50
    async function loadAudit() {
      var actor = document.getElementById('auditActor').value.trim()
      var action = document.getElementById('auditAction').value
      var qs = '?page=' + auditPage + '&limit=' + auditLimit +
        (actor ? '&actor=' + encodeURIComponent(actor) : '') +
        (action ? '&action=' + encodeURIComponent(action) : '')
      var r = await api('/api/admin/audit' + qs)
      var tbody = document.querySelector('#auditRows tbody')
      if (!r.ok) { tbody.innerHTML = DshCommon.emptyRow(4, '加载失败'); return }
      tbody.innerHTML = ''
      for (var i = 0; i < r.body.rows.length; i++) {
        var row = r.body.rows[i]
        tbody.insertAdjacentHTML(
          'beforeend',
          '<tr><td>' + fmtDateTime(row.ts) + '</td><td>' + esc(row.actorName || row.actor || 'system') + '</td><td>' + esc(row.action) + '</td><td class="hint">' + esc(truncate(row.detail || '', 80)) + '</td></tr>',
        )
      }
      if (!r.body.rows.length) tbody.innerHTML = DshCommon.emptyRow(4, '无记录')
      var pages = Math.max(1, Math.ceil(r.body.total / auditLimit))
      document.getElementById('auditPageInfo').textContent = '第 ' + auditPage + ' / ' + pages + ' 页（共 ' + r.body.total + ' 条）'
      document.getElementById('auditPrev').disabled = auditPage <= 1
      document.getElementById('auditNext').disabled = auditPage >= pages
    }
    document.getElementById('auditFilterBtn').addEventListener('click', function () { auditPage = 1; loadAudit() })
    document.getElementById('auditPrev').addEventListener('click', function () { if (auditPage > 1) { auditPage--; loadAudit() } })
    document.getElementById('auditNext').addEventListener('click', function () { auditPage++; loadAudit() })
    document.getElementById('auditActor').addEventListener('keydown', function (event) { if (event.key === 'Enter') { auditPage = 1; loadAudit() } })

    // ---------- 系统设置 ----------
    async function loadSettings() {
      var r = await api('/api/admin/settings')
      if (!r.ok) return
      document.getElementById('setAllowRegister').checked = r.body.allowRegister
      document.getElementById('setInviteCode').value = r.body.inviteCode || ''
      DshCommon.setMsg('settingsMsg', '', false)
      await loadSharedPatch()
    }

    // ---------- 共享插件层（patch） ----------
    async function loadSharedPatch() {
      var r = await api('/api/admin/shared-patch')
      if (!r.ok) return
      document.getElementById('sharedPatchYaml').value = r.body.yaml || ''
      document.getElementById('sharedPatchMeta').textContent = r.body.updatedAt
        ? '最近修改：' + fmtDateTime(r.body.updatedAt)
        : '尚未设置（所有用户当前没有共享 patch 层）'
      DshCommon.setMsg('sharedPatchMsg', '', false)
    }
    document.getElementById('saveSharedPatchBtn').addEventListener('click', function (event) {
      var btn = event.currentTarget
      void DshCommon.withBusy(btn, async function () {
        DshCommon.setMsg('sharedPatchMsg', '校验中（沙箱启动探测，约需数秒）…', false)
        var r = await api('/api/admin/shared-patch', {
          method: 'PUT',
          body: JSON.stringify({ yaml: document.getElementById('sharedPatchYaml').value }),
        })
        if (r.ok) {
          var note = r.body.bootValidation === 'pass' ? '已保存并同步 ' + r.body.synced + ' 个用户（启动校验通过）'
            : r.body.bootValidation === 'skipped' ? '已保存并同步 ' + r.body.synced + ' 个用户；启动校验未执行：' + (r.body.bootDetail || '')
            : '已保存'
          DshCommon.setMsg('sharedPatchMsg', note, false)
          await loadSharedPatch()
        } else {
          DshCommon.setMsg('sharedPatchMsg', '保存失败：' + (r.message || r.error), true)
        }
      })
    })
    document.getElementById('saveSettingsBtn').addEventListener('click', function (event) {
      var btn = event.currentTarget
      void DshCommon.withBusy(btn, async function () {
        var r = await api('/api/admin/settings', {
          method: 'PUT',
          body: JSON.stringify({
            allowRegister: document.getElementById('setAllowRegister').checked,
            inviteCode: document.getElementById('setInviteCode').value.trim(),
          }),
        })
        if (r.ok) DshCommon.setMsg('settingsMsg', '已保存（立即生效）', false)
        else DshCommon.setMsg('settingsMsg', '保存失败：' + r.error, true)
      })
    })

    // ---------- 插件市场管理 ----------
    function marketStatusHtml(item) {
      var html = ''
      if (item.validation) {
        if (item.validation.status === 'pass') html += '<span class="badge active" title="组合配置校验通过">✓ 校验</span> '
        else if (item.validation.status === 'fail') html += '<span class="badge pending" title="' + esc(item.validation.detail || '组合失败') + '">✗ 校验失败</span> '
        else html += '<span class="badge disabled" title="' + esc(item.validation.detail || '未能执行校验') + '">未校验</span> '
      }
      var d = item.disclosure
      if (d && d.declared && d.cloud === false) html += '<span class="badge active" title="作者声明数据不出本机/本内网">本地 ✓</span>'
      else if (d && d.declared && d.cloud === true) html += '<span class="badge pending" title="' + esc('云端端点：' + (d.network && d.network.length ? d.network.join('、') : '未列出')) + '">云端 ⚠</span>'
      else html += '<span class="badge disabled" title="作者未披露数据流向">未披露</span>'
      return html
    }

    async function loadMarketAdmin() {
      var tbody = document.querySelector('#marketAdminRows tbody')
      var r = await api('/api/admin/market')
      if (!r.ok) { tbody.innerHTML = DshCommon.emptyRow(7, '加载失败'); return }
      tbody.innerHTML = ''
      if (!r.body.items.length) {
        tbody.innerHTML = DshCommon.emptyRow(7, '尚未收录；上传 .tar.gz 导入第一个条目')
        return
      }
      for (var i = 0; i < r.body.items.length; i++) {
        var item = r.body.items[i]
        var validateBtn = item.kind === 'cordis-plugin'
          ? '<button class="btn small" data-validate="' + esc(item.id) + '" data-name="' + esc(item.name) + '">校验</button> '
          : ''
        var shareBtn = ''
        if (item.kind !== 'cordis-plugin') {
          shareBtn = item.shared
            ? '<button class="btn small" data-share="' + esc(item.id) + '" data-val="0" data-name="' + esc(item.name) + '">取消推送</button> '
            : '<button class="btn small" data-share="' + esc(item.id) + '" data-val="1" data-name="' + esc(item.name) + '">推送全员</button> '
        }
        var sharedBadge = item.shared ? '<span class="badge admin" title="自动装进每个用户 home，launch 时补齐/升级">已推送</span> ' : ''
        tbody.insertAdjacentHTML(
          'beforeend',
          '<tr><td>' + esc(item.name) + '</td><td>' + (KIND_LABEL[item.kind] || esc(item.kind)) + '</td><td>' + esc(item.version || '—') + '</td><td>' + sharedBadge + marketStatusHtml(item) + '</td><td>' + (item.installs || 0) + '</td><td>' + fmtDateTime(item.importedAt) + '</td><td>' + validateBtn + shareBtn + '<button class="btn small danger" data-del="' + esc(item.id) + '" data-name="' + esc(item.name) + '">删除</button></td></tr>',
        )
      }
    }
    document.getElementById('marketImportBtn').addEventListener('click', function (event) {
      var input = document.getElementById('marketTgz')
      var metaInput = document.getElementById('marketMeta')
      var file = input.files && input.files[0]
      var metaFile = metaInput && metaInput.files && metaInput.files[0]
      if (!file) {
        DshCommon.setMsg('marketImportMsg', '请先选择 .tar.gz 文件', true)
        return
      }
      var fd = new FormData()
      fd.append('file', file, file.name)
      if (metaFile) fd.append('meta', metaFile, metaFile.name)
      void DshCommon.uploadForm('/api/admin/market/import', fd, {
        btn: event.currentTarget,
        msg: 'marketImportMsg',
        busyText: '导入中（解包、判型、校验）…',
        failText: '导入失败',
        onOk: async function (body) {
          var names = (body.items || []).map(function (item) { return item.name + ' v' + (item.version || '—') }).join('、')
          var skippedNote = body.skipped && body.skipped.length
            ? '（跳过 ' + body.skipped.length + ' 项：' + body.skipped.map(function (s) { return s.name }).join('、') + '）'
            : ''
          DshCommon.setMsg('marketImportMsg', '已收录：' + names + skippedNote, false)
          input.value = ''
          if (metaInput) metaInput.value = ''
          await loadMarketAdmin()
        },
      })
    })
    document.querySelector('#marketAdminRows tbody').addEventListener('click', async function (event) {
      var del = event.target.closest('button[data-del]')
      if (del) {
        if (!window.confirm('从市场删除「' + del.dataset.name + '」？已安装用户不受影响（其安装记录将消失）。')) return
        var r = await api('/api/admin/market/' + encodeURIComponent(del.dataset.del), { method: 'DELETE' })
        if (!r.ok) alert('删除失败：' + r.error)
        await loadMarketAdmin()
        return
      }
      var val = event.target.closest('button[data-validate]')
      if (val) {
        DshCommon.setMsg('marketImportMsg', '正在对「' + val.dataset.name + '」执行沙箱启动探测（约需数秒）…', false)
        var res = await api('/api/admin/market/' + encodeURIComponent(val.dataset.validate) + '/validate', { method: 'POST' })
        if (res.ok) {
          DshCommon.setMsg('marketImportMsg', '校验结论：' + (res.body.validation.status === 'pass' ? '通过' : res.body.validation.status === 'fail' ? '失败 —— ' + (res.body.validation.detail || '') : '跳过 —— ' + (res.body.validation.detail || '')), res.body.validation.status !== 'pass')
        } else {
          DshCommon.setMsg('marketImportMsg', '校验失败：' + (res.error || ''), true)
        }
        await loadMarketAdmin()
        return
      }
      var share = event.target.closest('button[data-share]')
      if (share) {
        var toOn = share.dataset.val === '1'
        if (toOn && !window.confirm('把「' + share.dataset.name + '」推送全员？将自动装进每个用户 home，且用户无法自行卸载。')) return
        var r2 = await api('/api/admin/market/' + encodeURIComponent(share.dataset.share) + '/shared', { method: 'POST', body: JSON.stringify({ shared: toOn }) })
        if (!r2.ok) alert('操作失败：' + (r2.message || r2.error))
        await loadMarketAdmin()
      }
    })

    return { loadOps: loadOps, loadAudit: loadAudit, loadSettings: loadSettings, loadMarketAdmin: loadMarketAdmin }
  }

  window.initAdminExtras = initAdminExtras
})()
