/**
 * 账户设置面板：自助修改密码 + 登录会话（设备）查看与吊销。
 * 经 initAccountPanel({ api, esc }) 注入依赖，返回 { loadAccount }。
 */
;(function () {
  'use strict'

  function initAccountPanel(ctx) {
    var api = ctx.api
    var esc = ctx.esc
    var $ = function (id) { return document.getElementById(id) }

    // ---------- 修改密码 ----------
    function setPwMsg(text, isError) {
      var el = $('pwMsg')
      el.textContent = text
      el.classList.toggle('msg-error', !!isError)
    }
    $('pwSaveBtn').addEventListener('click', async function () {
      var current = $('pwCurrent').value
      var next = $('pwNew').value
      var next2 = $('pwNew2').value
      if (next.length < 8) { setPwMsg('新密码至少 8 位', true); return }
      if (next !== next2) { setPwMsg('两次输入的新密码不一致', true); return }
      var btn = $('pwSaveBtn')
      btn.disabled = true
      setPwMsg('提交中…', false)
      var r = await api('/api/me/password', { method: 'POST', body: JSON.stringify({ currentPassword: current, newPassword: next }) })
      btn.disabled = false
      if (!r.ok) {
        setPwMsg(r.error === 'invalid_credentials' ? '当前密码不正确' : '修改失败：' + r.error, true)
        return
      }
      $('pwCurrent').value = ''
      $('pwNew').value = ''
      $('pwNew2').value = ''
      setPwMsg('已修改；其他设备的会话已吊销', false)
      loadAccount()
    })

    // ---------- 会话 / 设备列表 ----------
    var currentId = null
    function deviceLabel(ua) {
      if (!ua) return '未知设备'
      var browser = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : '浏览器'
      var os = /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Mac OS/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : ''
      return browser + (os ? ' / ' + os : '')
    }
    async function loadAccount() {
      var r = await api('/api/me/sessions')
      if (!r.ok) return
      currentId = r.body.currentId
      var tbody = document.querySelector('#sessionRows tbody')
      tbody.innerHTML = ''
      for (var i = 0; i < r.body.sessions.length; i++) {
        var s = r.body.sessions[i]
        var isCurrent = s.id === currentId
        var action = isCurrent
          ? '<span class="hint">当前设备</span>'
          : '<button class="btn small danger" data-revoke="' + esc(s.id) + '">吊销</button>'
        tbody.insertAdjacentHTML(
          'beforeend',
          '<tr><td>' + esc(deviceLabel(s.userAgent)) + (isCurrent ? ' <span class="badge active">本机</span>' : '') + '</td><td>' + esc(s.ip || '—') + '</td><td>' + new Date(s.lastUsedAt).toLocaleString() + '</td><td>' + new Date(s.expiresAt).toLocaleString() + '</td><td>' + action + '</td></tr>',
        )
      }
      if (!r.body.sessions.length) tbody.innerHTML = '<tr class="empty"><td colspan="5">无活动会话</td></tr>'
    }
    document.querySelector('#sessionRows tbody').addEventListener('click', async function (event) {
      var btn = event.target.closest('button[data-revoke]')
      if (!btn) return
      var r = await api('/api/me/sessions/' + encodeURIComponent(btn.dataset.revoke), { method: 'DELETE' })
      if (!r.ok) { alert('吊销失败：' + r.error); return }
      await loadAccount()
    })
    $('revokeOthersBtn').addEventListener('click', async function () {
      if (!window.confirm('吊销除当前设备外的全部登录会话？')) return
      var r = await api('/api/me/sessions')
      if (!r.ok) return
      var others = r.body.sessions.filter(function (s) { return s.id !== r.body.currentId })
      for (var i = 0; i < others.length; i++) {
        await api('/api/me/sessions/' + encodeURIComponent(others[i].id), { method: 'DELETE' })
      }
      await loadAccount()
    })

    return { loadAccount: loadAccount }
  }

  window.initAccountPanel = initAccountPanel
})()
