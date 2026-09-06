/**
 * 管理员扩展窗口：运维监控（实例 + 磁盘）、审计日志（分页/筛选）、
 * 系统设置（注册开关/邀请码）、插件市场管理（导入/删除）。
 * 经 initAdminExtras({ api, esc }) 注入依赖，返回各窗口的加载函数。
 */
;(function () {
  'use strict'

  var fmtSize = window.DshCommon.fmtSize
  var KIND_LABEL = window.DshCommon.KIND_LABEL
  var STATUS_LABEL = { starting: '启动中', running: '运行中', crashed: '已崩溃', stopped: '已停止' }

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
      if (!r.ok) { tbody.innerHTML = '<tr class="empty"><td colspan="7">加载失败</td></tr>'; return }
      document.getElementById('opsDshVersion').textContent = r.body.dshVersion || '版本未知'
      tbody.innerHTML = ''
      if (!r.body.instances.length) {
        tbody.innerHTML = '<tr class="empty"><td colspan="7">当前没有运行中的实例</td></tr>'
      } else {
        for (var i = 0; i < r.body.instances.length; i++) {
          var inst = r.body.instances[i]
          var stopBtn = inst.status === 'starting' || inst.status === 'running'
            ? '<button class="btn small danger" data-stop="' + esc(inst.userId) + '" data-name="' + esc(inst.username) + '">停止</button>'
            : '<span class="hint">—</span>'
          tbody.insertAdjacentHTML(
            'beforeend',
            '<tr><td>' + esc(inst.username) + '</td><td>' + (inst.role === 'main' ? '主实例' : '看门狗') + '</td><td>' + (STATUS_LABEL[inst.status] || esc(inst.status)) + '</td><td>' + (inst.port != null ? inst.port : '—') + '</td><td>' + fmtUptime(inst.startedAt) + '</td><td>' + (inst.restarts || 0) + '</td><td>' + stopBtn + '</td></tr>',
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
      tbody.innerHTML = '<tr class="empty"><td colspan="4">统计中…（首次全量扫描可能较慢）</td></tr>'
      var r = await api('/api/admin/storage' + (refresh ? '?refresh=1' : ''))
      if (!r.ok) { tbody.innerHTML = '<tr class="empty"><td colspan="4">加载失败</td></tr>'; return }
      tbody.innerHTML = ''
      for (var i = 0; i < r.body.users.length; i++) {
        var u = r.body.users[i]
        tbody.insertAdjacentHTML('beforeend', '<tr><td>' + esc(u.username) + '</td><td>' + fmtSize(u.homeBytes) + '</td><td>' + fmtSize(u.wsBytes) + '</td><td>' + fmtSize(u.totalBytes) + '</td></tr>')
      }
      if (!r.body.users.length) tbody.innerHTML = '<tr class="empty"><td colspan="4">暂无用户</td></tr>'
      document.getElementById('opsStorageMeta').textContent = '合计 ' + fmtSize(r.body.totalBytes) + '（' + new Date(r.body.computedAt).toLocaleString() + ' 统计，缓存 60 秒）'
    }
    document.getElementById('opsStorageRefresh').addEventListener('click', function () { loadStorage(true) })

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
      if (!r.ok) { tbody.innerHTML = '<tr class="empty"><td colspan="4">加载失败</td></tr>'; return }
      tbody.innerHTML = ''
      for (var i = 0; i < r.body.rows.length; i++) {
        var row = r.body.rows[i]
        var detail = row.detail || ''
        if (detail.length > 80) detail = detail.slice(0, 80) + '…'
        tbody.insertAdjacentHTML(
          'beforeend',
          '<tr><td>' + new Date(row.ts).toLocaleString() + '</td><td>' + esc(row.actorName || row.actor || 'system') + '</td><td>' + esc(row.action) + '</td><td class="hint">' + esc(detail) + '</td></tr>',
        )
      }
      if (!r.body.rows.length) tbody.innerHTML = '<tr class="empty"><td colspan="4">无记录</td></tr>'
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
      document.getElementById('settingsMsg').textContent = ''
    }
    document.getElementById('saveSettingsBtn').addEventListener('click', async function (event) {
      var btn = event.currentTarget
      btn.disabled = true
      var r = await api('/api/admin/settings', {
        method: 'PUT',
        body: JSON.stringify({
          allowRegister: document.getElementById('setAllowRegister').checked,
          inviteCode: document.getElementById('setInviteCode').value.trim(),
        }),
      })
      btn.disabled = false
      var msg = document.getElementById('settingsMsg')
      if (r.ok) { msg.textContent = '已保存（立即生效）'; msg.classList.remove('msg-error') }
      else { msg.textContent = '保存失败：' + r.error; msg.classList.add('msg-error') }
    })

    // ---------- 插件市场管理 ----------
    async function loadMarketAdmin() {
      var tbody = document.querySelector('#marketAdminRows tbody')
      var r = await api('/api/admin/market')
      if (!r.ok) { tbody.innerHTML = '<tr class="empty"><td colspan="6">加载失败</td></tr>'; return }
      tbody.innerHTML = ''
      if (!r.body.items.length) {
        tbody.innerHTML = '<tr class="empty"><td colspan="6">尚未收录；上传 .tar.gz 导入第一个条目</td></tr>'
        return
      }
      for (var i = 0; i < r.body.items.length; i++) {
        var item = r.body.items[i]
        tbody.insertAdjacentHTML(
          'beforeend',
          '<tr><td>' + esc(item.name) + '</td><td>' + (KIND_LABEL[item.kind] || esc(item.kind)) + '</td><td>' + esc(item.version || '—') + '</td><td>' + (item.installs || 0) + '</td><td>' + new Date(item.importedAt).toLocaleString() + '</td><td><button class="btn small danger" data-del="' + esc(item.id) + '" data-name="' + esc(item.name) + '">删除</button></td></tr>',
        )
      }
    }
    document.getElementById('marketImportBtn').addEventListener('click', async function (event) {
      var input = document.getElementById('marketTgz')
      var file = input.files && input.files[0]
      var msg = document.getElementById('marketImportMsg')
      if (!file) { msg.textContent = '请先选择 .tar.gz 文件'; msg.classList.add('msg-error'); return }
      var btn = event.currentTarget
      btn.disabled = true
      msg.textContent = '导入中（解包与判定）…'
      msg.classList.remove('msg-error')
      var fd = new FormData()
      fd.append('file', file, file.name)
      try {
        var res = await fetch('/api/admin/market/import', { method: 'POST', body: fd })
        var body = await res.json().catch(function () { return {} })
        if (res.ok) {
          msg.textContent = '已收录：' + body.item.name + ' v' + (body.item.version || '—')
          input.value = ''
          await loadMarketAdmin()
        } else {
          msg.textContent = '导入失败：' + (body.message || body.error || res.status)
          msg.classList.add('msg-error')
        }
      } catch (err) {
        msg.textContent = '导入失败：网络错误'
        msg.classList.add('msg-error')
      } finally {
        btn.disabled = false
      }
    })
    document.querySelector('#marketAdminRows tbody').addEventListener('click', async function (event) {
      var btn = event.target.closest('button[data-del]')
      if (!btn) return
      if (!window.confirm('从市场删除「' + btn.dataset.name + '」？已安装用户不受影响（其安装记录将消失）。')) return
      var r = await api('/api/admin/market/' + encodeURIComponent(btn.dataset.del), { method: 'DELETE' })
      if (!r.ok) alert('删除失败：' + r.error)
      await loadMarketAdmin()
    })

    return { loadOps: loadOps, loadAudit: loadAudit, loadSettings: loadSettings, loadMarketAdmin: loadMarketAdmin }
  }

  window.initAdminExtras = initAdminExtras
})()
