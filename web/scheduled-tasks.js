/**
 * 定时任务（用户侧）：创建/编辑/启停/删除自己的排程 agent 任务，
 * 立即运行与查看运行历史。任务以一次性 headless DSH 在用户工作区里
 * 执行，单用户同时只跑一个（后端调度器保证）。
 * 经 initScheduledTasks({ api, esc }) 注入依赖，返回 { loadTasks }。
 */
;(function () {
  'use strict'

  var RUN_STATUS = { running: '运行中', ok: '完成', fail: '失败', timeout: '超时' }
  var fmtDateTime = window.DshCommon.fmtDateTime
  var truncate = window.DshCommon.truncate

  function initScheduledTasks(ctx) {
    var api = ctx.api
    var esc = ctx.esc
    var setMsg = function (text, isErr) { window.DshCommon.setMsg('taskMsg', text, isErr) }
    var editingId = null // 非空 = 表单处于编辑该任务的模式

    function scheduleDesc(t) {
      if (t.scheduleKind === 'interval') return '每 ' + t.intervalMinutes + ' 分钟'
      return '每天 ' + esc(t.dailyTime || '09:00')
    }

    function statusBadge(t) {
      if (t.running) return '<span class="badge pending">运行中</span> '
      if (!t.enabled) return '<span class="badge disabled">已暂停</span> '
      return '<span class="badge active">已启用</span> '
    }

    function lastRunHtml(t) {
      if (!t.lastRunAt) return '<span class="hint">从未运行</span>'
      var cls = t.lastStatus === 'fail' || t.lastStatus === 'timeout' ? 'msg-error' : ''
      return '<span class="hint ' + cls + '">上次：' + fmtDateTime(t.lastRunAt) + '（' + (RUN_STATUS[t.lastStatus] || t.lastStatus || '—') + '）</span>'
    }

    function renderTasks(r) {
      var pane = document.getElementById('taskList')
      if (!r.body.tasks.length) {
        pane.innerHTML = '<p class="hint">还没有定时任务。用下方表单创建第一个（例如每天 9 点汇总工作区变更）。</p>'
        return
      }
      pane.innerHTML = ''
      for (var i = 0; i < r.body.tasks.length; i++) {
        var t = r.body.tasks[i]
        var card = document.createElement('div')
        card.className = 'plugin-item'
        var actions =
          '<button class="btn small primary" data-run="' + esc(t.id) + '"' + (t.running ? ' disabled' : '') + '>立即运行</button> ' +
          '<button class="btn small" data-toggle="' + esc(t.id) + '" data-val="' + (t.enabled ? '0' : '1') + '">' + (t.enabled ? '暂停' : '启用') + '</button> ' +
          '<button class="btn small" data-runs="' + esc(t.id) + '" data-name="' + esc(t.name) + '">运行记录</button> ' +
          '<button class="btn small" data-edit="' + esc(t.id) + '">编辑</button> ' +
          '<button class="btn small danger" data-del="' + esc(t.id) + '" data-name="' + esc(t.name) + '">删除</button>'
        card.innerHTML =
          '<div><strong>' + esc(t.name) + '</strong> ' + statusBadge(t) + '<span class="hint">' + scheduleDesc(t) + '</span></div>' +
          '<div class="hint">' + esc(truncate(t.prompt, 120)) + '</div>' +
          '<div class="hint">下次：' + (t.enabled ? fmtDateTime(t.nextRunAt) : '—（已暂停）') + '</div>' +
          '<div>' + lastRunHtml(t) + '</div>' +
          '<div class="row-actions gap-top-s">' + actions + '</div>'
        pane.appendChild(card)
      }
    }

    async function loadTasks() {
      var r = await api('/api/me/tasks')
      if (r.ok) renderTasks(r)
      else document.getElementById('taskList').innerHTML = '<p class="hint">加载失败：' + esc(r.error) + '</p>'
    }

    function fillForm(t) {
      editingId = t ? t.id : null
      document.getElementById('taskFormTitle').textContent = t ? '编辑任务：' + t.name : '新建任务'
      document.getElementById('taskName').value = t ? t.name : ''
      document.getElementById('taskPrompt').value = t ? t.prompt : ''
      var kind = t ? t.scheduleKind : 'interval'
      document.getElementById('taskKind').value = kind
      document.getElementById('taskInterval').value = t && t.intervalMinutes ? t.intervalMinutes : 60
      document.getElementById('taskDaily').value = (t && t.dailyTime) || '09:00'
      syncKindInputs()
      document.getElementById('taskSubmitBtn').textContent = t ? '保存修改' : '创建'
      document.getElementById('taskCancelEditBtn').classList.toggle('hidden', !t)
    }

    function syncKindInputs() {
      var interval = document.getElementById('taskKind').value === 'interval'
      document.getElementById('taskIntervalWrap').classList.toggle('hidden', !interval)
      document.getElementById('taskDailyWrap').classList.toggle('hidden', interval)
    }

    function collectForm() {
      var body = {
        name: document.getElementById('taskName').value.trim(),
        prompt: document.getElementById('taskPrompt').value,
        schedule: { kind: document.getElementById('taskKind').value },
      }
      if (body.schedule.kind === 'interval') body.schedule.intervalMinutes = Number(document.getElementById('taskInterval').value)
      else body.schedule.dailyTime = document.getElementById('taskDaily').value
      return body
    }

    document.getElementById('taskKind').addEventListener('change', syncKindInputs)

    document.getElementById('taskSubmitBtn').addEventListener('click', function (event) {
      var body = collectForm()
      if (!body.name) { setMsg('请填写任务名称', true); return }
      if (!body.prompt.trim()) { setMsg('请填写任务指令', true); return }
      var btn = event.currentTarget
      void window.DshCommon.withBusy(btn, async function () {
        var r = editingId === null
          ? await api('/api/me/tasks', { method: 'POST', body: JSON.stringify(body) })
          : await api('/api/me/tasks/' + encodeURIComponent(editingId), { method: 'PUT', body: JSON.stringify(body) })
        if (r.ok) {
          setMsg(editingId === null ? '已创建' : '已保存')
          fillForm(null)
          await loadTasks()
        } else {
          setMsg('保存失败：' + (r.message || r.error), true)
        }
      })
    })

    document.getElementById('taskCancelEditBtn').addEventListener('click', function () { fillForm(null); setMsg('') })

    document.getElementById('taskList').addEventListener('click', async function (event) {
      var btn = event.target.closest('button')
      if (!btn) return
      var runs = btn.getAttribute('data-runs')
      if (runs) {
        var rr = await api('/api/me/tasks/' + encodeURIComponent(runs) + '/runs?limit=20')
        var pane = document.getElementById('taskRuns')
        pane.classList.remove('hidden')
        document.getElementById('taskRunsTitle').textContent = '「' + btn.dataset.name + '」最近运行'
        if (!rr.ok) { pane.innerHTML = '<p class="hint">加载失败</p>'; return }
        if (!rr.body.runs.length) { pane.innerHTML = '<p class="hint">还没有运行记录（点「立即运行」试一次）。</p>'; return }
        var html = '<table class="admin"><thead><tr><th>开始时间</th><th>触发</th><th>状态</th><th>耗时</th><th>输出尾部</th></tr></thead><tbody>'
        for (var i = 0; i < rr.body.runs.length; i++) {
          var run = rr.body.runs[i]
          var dur = run.finishedAt ? Math.round((run.finishedAt - run.startedAt) / 1000) + ' 秒' : '—'
          html += '<tr><td>' + fmtDateTime(run.startedAt) + '</td><td>' + (run.triggerKind === 'manual' ? '手动' : '排程') + '</td><td>' + (RUN_STATUS[run.status] || run.status) + '</td><td>' + dur + '</td><td class="hint">' + esc(truncate(run.detail || '', 160)) + '</td></tr>'
        }
        pane.innerHTML = html + '</tbody></table>'
        return
      }
      var runNow = btn.getAttribute('data-run')
      if (runNow) {
        var r1 = await api('/api/me/tasks/' + encodeURIComponent(runNow) + '/run', { method: 'POST' })
        if (!r1.ok) alert('触发失败：' + (r1.message || r1.error))
        await loadTasks()
        return
      }
      var toggle = btn.getAttribute('data-toggle')
      if (toggle) {
        var r2 = await api('/api/me/tasks/' + encodeURIComponent(toggle), { method: 'PUT', body: JSON.stringify({ enabled: btn.dataset.val === '1' }) })
        if (!r2.ok) alert('操作失败：' + (r2.message || r2.error))
        await loadTasks()
        return
      }
      var edit = btn.getAttribute('data-edit')
      if (edit) {
        var r3 = await api('/api/me/tasks')
        if (r3.ok) {
          var task = null
          for (var j = 0; j < r3.body.tasks.length; j++) {
            if (r3.body.tasks[j].id === edit) task = r3.body.tasks[j]
          }
          if (task) { fillForm(task); setMsg('') }
        }
        return
      }
      var del = btn.getAttribute('data-del')
      if (del) {
        if (!window.confirm('删除任务「' + btn.dataset.name + '」？运行历史一并删除。')) return
        var r4 = await api('/api/me/tasks/' + encodeURIComponent(del), { method: 'DELETE' })
        if (!r4.ok) alert('删除失败：' + (r4.message || r4.error))
        await loadTasks()
      }
    })

    return { loadTasks: loadTasks }
  }

  window.initScheduledTasks = initScheduledTasks
})()
