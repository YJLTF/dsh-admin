/**
 * 插件市场（用户侧）：浏览管理员收录的插件/技能/预设，安装/更新/
 * 卸载到自己的 DSH home。安装/卸载后若 DSH 正在运行会提示重启生效。
 * 经 initMarket({ api, esc, refreshDsh }) 注入依赖，返回 { loadMarket }。
 */
;(function () {
  'use strict'

  var KIND_LABEL = window.DshCommon.KIND_LABEL
  var INSTALL_ERR = {
    not_found: '条目不存在（可能已被管理员删除）',
    conflicts_with_profile_bundle: '同名插件已在 profile 中，无需从市场安装',
  }

  function initMarket(ctx) {
    var api = ctx.api
    var esc = ctx.esc
    var refreshDsh = ctx.refreshDsh

    function offerRestart(body) {
      if (body && body.restartRecommended) {
        if (window.confirm('已生效。当前 DSH 正在运行，需要重启后加载变更，现在重启吗？')) {
          void api('/api/dsh/restart', { method: 'POST', body: JSON.stringify({ command: '' }) }).then(function () { refreshDsh() })
        }
      } else {
        alert('已完成')
      }
    }

    async function loadMarket() {
      var pane = document.getElementById('pluginPaneMarket')
      var r = await api('/api/me/market')
      if (!r.ok) {
        pane.innerHTML = '<p class="hint">市场加载失败：' + esc(r.error) + '</p>'
        return
      }
      var installedByName = {}
      for (var i = 0; i < r.body.installed.length; i++) installedByName[r.body.installed[i].name + '/' + r.body.installed[i].kind] = r.body.installed[i]
      if (!r.body.items.length) {
        pane.innerHTML = '<p class="hint">管理员尚未收录任何插件/技能。可在有网机器下载 GitHub 归档后请管理员导入。</p>'
        return
      }
      pane.innerHTML = ''
      for (var j = 0; j < r.body.items.length; j++) {
        var item = r.body.items[j]
        var installed = installedByName[item.name + '/' + item.kind]
        var card = document.createElement('div')
        card.className = 'plugin-item market-card'
        var badge = '<span class="badge active">' + KIND_LABEL[item.kind] + '</span>'
        var version = esc(item.version || '—')
        var warnHtml = ''
        for (var k = 0; k < (item.warnings || []).length; k++) {
          warnHtml += '<div class="hint msg-error">⚠ ' + esc(item.warnings[k]) + '</div>'
        }
        var button = ''
        if (!installed) {
          button = '<button class="btn small primary" data-install="' + esc(item.id) + '">安装</button>'
        } else {
          button =
            '<span class="hint">已装 v' + esc(installed.version || '—') + '</span>' +
            (installed.updateAvailable
              ? '<button class="btn small primary" data-install="' + esc(item.id) + '">更新到 v' + esc(installed.latestVersion || '—') + '</button>'
              : '') +
            '<button class="btn small danger" data-uninstall="' + esc(item.name) + '">卸载</button>'
        }
        card.innerHTML =
          '<div><strong>' + esc(item.name) + '</strong> ' + badge + ' <span class="hint">v' + version + '</span></div>' +
          (item.description ? '<div class="hint">' + esc(item.description) + '</div>' : '') +
          warnHtml +
          '<div class="row-actions">' + button + '</div>'
        pane.appendChild(card)
      }
    }

    /** 在市场面板上按 data-* 属性委托点击（先定义，供下方两处使用）。 */
    function paneClick(attr, handler) {
      document.getElementById('pluginPaneMarket').addEventListener('click', function (event) {
        var btn = event.target.closest('button[' + attr + ']')
        if (btn) handler(btn.getAttribute(attr))
      })
    }

    paneClick('data-install', async function (id) {
      var r = await api('/api/me/market/' + encodeURIComponent(id) + '/install', { method: 'POST' })
      if (!r.ok) { alert('安装失败：' + (INSTALL_ERR[r.error] || r.error)); return }
      offerRestart(r.body)
      await loadMarket()
    })

    paneClick('data-uninstall', async function (name) {
      if (!window.confirm('卸载「' + name + '」？将从你的 DSH 环境移除对应文件。')) return
      var r = await api('/api/me/market/uninstall', { method: 'POST', body: JSON.stringify({ name: name }) })
      if (!r.ok) { alert('卸载失败：' + (r.error === 'not_installed' ? '记录不存在' : r.error)); return }
      offerRestart(r.body)
      await loadMarket()
    })

    return { loadMarket: loadMarket }
  }

  window.initMarket = initMarket
})()
