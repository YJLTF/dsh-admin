/**
 * 入站 Webhook（用户侧）：创建（token 只显示一次）/启停/删除内网事件
 * 触发器，查看触发记录。触发端点为公开 /hooks/:token（异步执行）。
 * 经 initWebhooks({ api, esc }) 注入依赖，返回 { loadWebhooks }。
 */
;(function () {
  'use strict'

  var fmtDateTime = window.DshCommon.fmtDateTime
  var truncate = window.DshCommon.truncate

  function initWebhooks(ctx) {
    var api = ctx.api
    var esc = ctx.esc
    var setMsg = function (text, isErr) { window.DshCommon.setMsg('whMsg', text, isErr) }

    function renderList(hooks) {
      var pane = document.getElementById('whList')
      if (!hooks.length) {
        pane.innerHTML = '<p class="hint">还没有 webhook。创建一个，把 token 交给内网自动化系统。</p>'
        return
      }
      pane.innerHTML = ''
      for (var i = 0; i < hooks.length; i++) {
        var h = hooks[i]
        var card = document.createElement('div')
        card.className = 'plugin-item'
        card.innerHTML =
          '<div><strong>' + esc(h.name) + '</strong> ' +
          (h.enabled ? '<span class="badge active">启用</span> ' : '<span class="badge disabled">已停用</span> ') +
          (h.running ? '<span class="badge pending">执行中</span> ' : '') +
          '<span class="hint">token ' + esc(h.tokenPreview) + '</span></div>' +
          '<div class="hint">' + esc(truncate(h.prompt, 120)) + '</div>' +
          '<div class="hint">' + (h.lastFiredAt ? '最近触发：' + fmtDateTime(h.lastFiredAt) : '从未触发') + '</div>' +
          '<div class="row-actions gap-top-s">' +
          '<button class="btn small" data-toggle="' + esc(h.id) + '" data-val="' + (h.enabled ? '0' : '1') + '">' + (h.enabled ? '停用' : '启用') + '</button> ' +
          '<button class="btn small" data-fires="' + esc(h.id) + '" data-name="' + esc(h.name) + '">触发记录</button> ' +
          '<button class="btn small danger" data-del="' + esc(h.id) + '" data-name="' + esc(h.name) + '">删除</button>' +
          '</div>'
        pane.appendChild(card)
      }
    }

    async function loadWebhooks() {
      var r = await api('/api/me/webhooks')
      if (r.ok) renderList(r.body.webhooks)
      else document.getElementById('whList').innerHTML = '<p class="hint">加载失败：' + esc(r.error) + '</p>'
    }

    document.getElementById('whCreateBtn').addEventListener('click', function (event) {
      var body = {
        name: document.getElementById('whName').value.trim(),
        prompt: document.getElementById('whPrompt').value,
      }
      if (!body.name || !body.prompt.trim()) { setMsg('请填写名称与指令', true); return }
      var btn = event.currentTarget
      void window.DshCommon.withBusy(btn, async function () {
        var r = await api('/api/me/webhooks', { method: 'POST', body: JSON.stringify(body) })
        if (r.ok) {
          setMsg('已创建')
          document.getElementById('whName').value = ''
          document.getElementById('whPrompt').value = ''
          var urlBox = document.getElementById('whNewUrl')
          urlBox.classList.remove('hidden')
          urlBox.textContent = '触发 URL（只显示这一次，立即复制）：POST ' + location.origin + r.body.url
          await loadWebhooks()
        } else {
          setMsg('创建失败：' + (r.message || r.error), true)
        }
      })
    })

    document.getElementById('whList').addEventListener('click', async function (event) {
      var btn = event.target.closest('button')
      if (!btn) return
      var fires = btn.getAttribute('data-fires')
      if (fires) {
        var rr = await api('/api/me/webhooks/' + encodeURIComponent(fires) + '/fires?limit=20')
        var pane = document.getElementById('whFires')
        pane.classList.remove('hidden')
        document.getElementById('whFiresTitle').textContent = '「' + btn.dataset.name + '」触发记录'
        if (!rr.ok) { pane.innerHTML = '<p class="hint">加载失败</p>'; return }
        if (!rr.body.fires.length) { pane.innerHTML = '<p class="hint">还没有触发记录。</p>'; return }
        var html = '<table class="admin"><thead><tr><th>时间</th><th>状态</th><th>说明</th></tr></thead><tbody>'
        for (var i = 0; i < rr.body.fires.length; i++) {
          var f = rr.body.fires[i]
          html += '<tr><td>' + fmtDateTime(f.firedAt) + '</td><td>' + esc(f.status) + '</td><td class="hint">' + esc(f.detail || '') + '</td></tr>'
        }
        pane.innerHTML = html + '</tbody></table>'
        return
      }
      var toggle = btn.getAttribute('data-toggle')
      if (toggle) {
        var r2 = await api('/api/me/webhooks/' + encodeURIComponent(toggle) + '/enabled', { method: 'POST', body: JSON.stringify({ enabled: btn.dataset.val === '1' }) })
        if (!r2.ok) alert('操作失败：' + (r2.message || r2.error))
        await loadWebhooks()
        return
      }
      var del = btn.getAttribute('data-del')
      if (del) {
        if (!window.confirm('删除 webhook「' + btn.dataset.name + '」？token 立即失效，触发记录一并删除。')) return
        var r3 = await api('/api/me/webhooks/' + encodeURIComponent(del), { method: 'DELETE' })
        if (!r3.ok) alert('删除失败：' + (r3.message || r3.error))
        await loadWebhooks()
      }
    })

    return { loadWebhooks: loadWebhooks }
  }

  window.initWebhooks = initWebhooks
})()
