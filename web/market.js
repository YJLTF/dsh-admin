/**
 * 插件市场（用户侧）：浏览管理员收录的插件/技能/预设，安装/更新/
 * 卸载到自己的 DSH home。cordis 插件在 dsh ≥0.1.2-rc.1 上随安装即时
 * 热生效（web profile 默认 live patch 重载），旧版 dsh 回退为提示
 * 重启；卡片展示披露徽章（云端依赖）与导入期校验结论。
 * 经 initMarket({ api, esc, refreshDsh, restartDsh }) 注入依赖，
 * 返回 { loadMarket }。
 */
;(function () {
  'use strict'

  var KIND_LABEL = window.DshCommon.KIND_LABEL
  var INSTALL_ERR = {
    not_found: '条目不存在（可能已被管理员删除）',
    conflicts_with_profile_bundle: '同名插件已在 profile 中，无需从市场安装',
    managed_by_shared: '该条目由管理员推送全员，不能自行卸载',
  }

  function initMarket(ctx) {
    var api = ctx.api
    var esc = ctx.esc
    var refreshDsh = ctx.refreshDsh
    var restartDsh = ctx.restartDsh

    function offerReload(body) {
      if (body && body.reload === 'hot') {
        alert('已完成：dsh ≥ 0.1.2-rc.1 的 web profile 实时监视插件 patch（live 重载），变更已即时生效。若 DSH 界面暂未出现新插件，可稍候刷新，或手动重启一次。')
        return
      }
      if (body && body.restartRecommended) {
        if (window.confirm('已生效。当前 DSH 正在运行，需要重启后加载变更，现在重启吗？')) {
          void restartDsh()
        }
      } else {
        alert('已完成')
      }
    }

    /** 披露徽章（STANDARD §9 最小子集）：本地 ✓ / 云端 ⚠（悬停看端点）/ 未声明。 */
    function disclosureBadge(d) {
      if (!d || !d.declared || typeof d.cloud !== 'boolean') {
        return '<span class="badge disabled" title="作者未声明数据流向（是否发往云端/端点/凭据）">披露未声明</span>'
      }
      if (d.cloud === false) {
        return '<span class="badge active" title="作者声明：数据不出本机/本内网' + (d.offlineMode ? '；存在完全离线使用路径' : '') + '">本地 · 无云端依赖 ✓</span>'
      }
      var tips = '作者声明存在云端依赖'
      if (d.network && d.network.length) tips += '，端点：' + d.network.join('、')
      if (d.retention) tips += '，保留：' + d.retention
      return '<span class="badge pending" title="' + esc(tips) + '">云端依赖 ⚠</span>'
    }

    /** 导入期沙箱启动探测结论（仅 cordis 插件）。 */
    function validationBadge(v) {
      if (!v) return ''
      if (v.status === 'pass') return '<span class="badge active" title="' + esc(window.DshCommon.fmtDateTime(v.checkedAt)) + ' 启动探测通过">✓ 启动校验</span>'
      return '<span class="badge pending" title="未完成启动探测">未校验</span>'
    }

    function packMetaHint(m) {
      if (!m) return ''
      var parts = []
      if (m.selfContained) parts.push('自包含（离线可装）')
      if (m.dshVersion) parts.push('打包时 dsh ' + esc(m.dshVersion))
      if (m.source) parts.push('来源 ' + esc(m.source))
      return parts.length ? '<span class="hint">' + parts.join(' · ') + '</span> ' : ''
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
        var badge = '<span class="badge active">' + (KIND_LABEL[item.kind] || esc(item.kind)) + '</span>'
        if (item.shared) badge += ' <span class="badge admin" title="管理员推送全员：自动安装/升级，不能自行卸载">已推送</span>'
        var version = esc(item.version || '—')
        var warnHtml = ''
        for (var k = 0; k < (item.warnings || []).length; k++) {
          warnHtml += '<div class="hint msg-error">⚠ ' + esc(item.warnings[k]) + '</div>'
        }
        if (item.validation && item.validation.status === 'fail') {
          warnHtml += '<div class="hint msg-error">✗ 启动校验未通过：' + esc(item.validation.detail || '启动即崩') + '</div>'
        }
        var button = ''
        if (!installed) {
          button = '<button class="btn small primary" data-install="' + esc(item.id) + '">安装</button>'
        } else {
          button =
            '<span class="hint">已装 v' + esc(installed.version || '—') + '</span>' +
            (installed.updateAvailable
              ? '<button class="btn small primary" data-install="' + esc(item.id) + '">更新到 v' + esc(installed.latestVersion || '—') + '</button>'
              : '')
          if (installed.source === 'shared') {
            button += '<span class="hint">管理员推送 · 不能卸载</span>'
          } else {
            button += '<button class="btn small danger" data-uninstall="' + esc(item.name) + '">卸载</button>'
          }
        }
        card.innerHTML =
          '<div><strong>' + esc(item.name) + '</strong> ' + badge + ' ' + validationBadge(item.validation) + ' ' + disclosureBadge(item.disclosure) + ' <span class="hint">v' + version + '</span></div>' +
          (item.description ? '<div class="hint">' + esc(item.description) + '</div>' : '') +
          packMetaHint(item.packMeta) +
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
      offerReload(r.body)
      await loadMarket()
    })

    paneClick('data-uninstall', async function (name) {
      if (!window.confirm('卸载「' + name + '」？将从你的 DSH 环境移除对应文件。')) return
      var r = await api('/api/me/market/uninstall', { method: 'POST', body: JSON.stringify({ name: name }) })
      if (!r.ok) { alert('卸载失败：' + (INSTALL_ERR[r.error] || r.error)); return }
      offerReload(r.body)
      await loadMarket()
    })

    return { loadMarket: loadMarket }
  }

  window.initMarket = initMarket
})()
