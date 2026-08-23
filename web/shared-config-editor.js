// DSH 共享模型配置的管理端编辑器 — 供桌面管理台
// 窗口（win-shared）使用。每个提供方渲染一张卡片，涵盖
// DSH 提供方指南中的字段（路由接线、逐模型 `input`、
// 路由级 `defaultInput`、目录 `modelOverrides`）以及凭据
// 行，通过 /api/admin/shared-config 加载和保存。
// initSharedConfigEditor(onSaved?) → { loadShared }
function initSharedConfigEditor(onSaved) {
  const provBox = document.getElementById('sharedProviders')
  const credBody = document.querySelector('#sharedCreds tbody')
  const msg = document.getElementById('sharedMsg')

  // API 协议建议（自由文本 — 完整集合由目录定义）。
  if (!document.getElementById('dshApiProtocols')) {
    const dl = document.createElement('datalist')
    dl.id = 'dshApiProtocols'
    dl.innerHTML = '<option value="openai-completions"></option>'
    document.body.appendChild(dl)
  }

  const inlineInput = 'width:100%;padding:6px 8px;border:1px solid var(--line);border-radius:6px;background:var(--surface-2);font-size:13px;color:var(--ink)'

  function textInput(value = '', placeholder = '', style = '') {
    const input = document.createElement('input')
    input.type = 'text'
    input.value = value
    input.placeholder = placeholder
    if (style) input.style.cssText = style
    return input
  }

  function removeBtn(target) {
    const btn = document.createElement('button')
    btn.className = 'btn mini-del'
    btn.type = 'button'
    btn.setAttribute('aria-label', '删除此行')
    btn.textContent = '×'
    btn.onclick = () => target.remove()
    return btn
  }

  // 文本/图片复选框对；_read() → ['text','image'] 的子集（为空则省略）。
  function modalityChecks(checked = []) {
    const wrap = document.createElement('span')
    wrap.className = 'modality'
    const boxes = ['text', 'image'].map((m) => {
      const label = document.createElement('label')
      const box = document.createElement('input')
      box.type = 'checkbox'
      box.checked = checked.includes(m)
      label.append(box, document.createTextNode(m === 'text' ? '文本' : '图片'))
      wrap.appendChild(label)
      return box
    })
    wrap._read = () => ['text', 'image'].filter((m, i) => boxes[i].checked)
    return wrap
  }

  function field(labelText, input) {
    const cell = document.createElement('div')
    const label = document.createElement('label')
    label.textContent = labelText
    cell.append(label, input)
    return cell
  }

  // models[] 的一项：模型 id + 其自身的输入模态声明。
  function modelRow({ id = '', input = [] } = {}) {
    const row = document.createElement('div')
    row.className = 'mrow'
    const idIn = textInput(id, '例如 vision-preview')
    const mods = modalityChecks(input)
    row.append(idIn, mods, removeBtn(row))
    row._read = () => {
      const mid = idIn.value.trim()
      if (!mid) return null
      const modality = mods._read()
      return modality.length ? { id: mid, input: modality } : { id: mid }
    }
    return row
  }

  // modelOverrides 的一项：模型 id → 收窄后的输入模态。
  function overrideRow({ id = '', input = [] } = {}) {
    const row = document.createElement('div')
    row.className = 'mrow'
    const idIn = textInput(id, '例如 claude-sonnet-4-5')
    const mods = modalityChecks(input)
    row.append(idIn, mods, removeBtn(row))
    row._read = () => {
      const mid = idIn.value.trim()
      const modality = mods._read()
      return mid && modality.length ? { id: mid, input: modality } : null
    }
    return row
  }

  function subList(labelText, rowBuilder, rows) {
    const wrap = document.createElement('div')
    const label = document.createElement('p')
    label.className = 'sub-label'
    label.textContent = labelText
    const list = document.createElement('div')
    for (const item of rows) list.appendChild(rowBuilder(item))
    const add = document.createElement('button')
    add.className = 'btn ghost small'
    add.textContent = '+ 添加'
    add.onclick = () => list.appendChild(rowBuilder())
    wrap.append(label, list, add)
    return { list, el: wrap }
  }

  function providerCard(p = {}) {
    const card = document.createElement('div')
    card.className = 'prov-card'

    // 头部：固定标签 + 路由名徽章（随输入实时更新）+ 删除按钮。
    const head = document.createElement('div')
    head.className = 'prov-head'
    const title = document.createElement('span')
    title.className = 't'
    title.textContent = '提供方'
    const chip = document.createElement('span')
    chip.className = 'prov-chip'
    chip.title = '路由名'
    chip.textContent = p.route || '未命名'
    head.append(title, chip, removeBtn(card))

    const routeIn = textInput(p.route || '', '例如 deepseek')
    routeIn.addEventListener('input', () => { chip.textContent = routeIn.value.trim() || '未命名' })
    const nameIn = textInput(p.displayName || '', '例如 DeepSeek 官方')
    const apiIn = textInput(p.api || '', '例如 openai-completions')
    apiIn.setAttribute('list', 'dshApiProtocols')
    const urlIn = textInput(p.baseURL || '', 'https://api.deepseek.com')
    const refIn = textInput(p.apiKeyEnv || '', '例如 SHARED_DEEPSEEK_KEY')

    const grid = document.createElement('div')
    grid.className = 'grid'
    grid.append(
      field('路由名 *', routeIn),
      field('显示名', nameIn),
      field('API 协议 api', apiIn),
      field('Base URL', urlIn),
      field('API Key 引用 apiKeyEnv', refIn),
    )

    const diLabel = document.createElement('p')
    diLabel.className = 'sub-label'
    diLabel.textContent = '默认输入模态 defaultInput（该路由下未被目录描述的模型的回退，默认纯文本）'
    const defaultMods = modalityChecks(p.defaultInput || [])

    const models = subList('模型列表 models（自定义提供方至少填一个；视觉模型勾选图片）', modelRow, p.models || [])
    const overrides = subList(
      '模型覆盖 modelOverrides（目录提供方按模型 id 收窄模态）',
      overrideRow,
      Object.entries(p.modelOverrides || {}).map(([id, v]) => ({ id, input: (v && v.input) || [] })),
    )

    card.append(head, grid, diLabel, defaultMods, models.el, overrides.el)
    card._read = () => {
      const route = routeIn.value.trim()
      if (!route) return null
      const profile = {}
      if (nameIn.value.trim()) profile.displayName = nameIn.value.trim()
      if (apiIn.value.trim()) profile.api = apiIn.value.trim()
      if (urlIn.value.trim()) profile.baseURL = urlIn.value.trim()
      if (refIn.value.trim()) profile.apiKeyEnv = refIn.value.trim()
      const fallback = defaultMods._read()
      if (fallback.length) profile.defaultInput = fallback
      const modelList = [...models.list.children].map((row) => row._read()).filter(Boolean)
      if (modelList.length) profile.models = modelList
      const modelOverrides = {}
      for (const row of overrides.list.children) {
        const o = row._read()
        if (o) modelOverrides[o.id] = { input: o.input }
      }
      if (Object.keys(modelOverrides).length) profile.modelOverrides = modelOverrides
      return { route, profile }
    }
    return card
  }

  function credRow(ref = '', key = '') {
    const tr = document.createElement('tr')
    const refCell = document.createElement('td')
    refCell.appendChild(textInput(ref, '例如 SHARED_DEEPSEEK_KEY', inlineInput))
    const keyCell = document.createElement('td')
    const keyIn = document.createElement('input')
    keyIn.type = 'password'
    keyIn.placeholder = 'sk-...'
    keyIn.value = key
    keyIn.style.cssText = inlineInput
    keyCell.appendChild(keyIn)
    const delCell = document.createElement('td')
    delCell.appendChild(removeBtn(tr))
    tr.append(refCell, keyCell, delCell)
    tr._read = () => ({ ref: refCell.querySelector('input').value.trim(), key: keyIn.value })
    return tr
  }

  document.getElementById('addProviderBtn').onclick = () => provBox.appendChild(providerCard())
  document.getElementById('addCredBtn').onclick = () => credBody.appendChild(credRow())

  async function loadShared() {
    // 这里的失败只降级本编辑器，不能让未捕获的 rejection
    // 中断桌面其余初始化（desktop 的 init 是串行 await 的）。
    try {
      const res = await fetch('/api/admin/shared-config')
      if (!res.ok) return
      const body = await res.json()
      provBox.innerHTML = ''
      credBody.innerHTML = ''
      for (const [route, profile] of Object.entries(body.payload.providers || {})) provBox.appendChild(providerCard({ route, ...profile }))
      for (const [ref, key] of Object.entries(body.payload.credentials || {})) credBody.appendChild(credRow(ref, key))
      const meta = []
      if (body.version > 0) { meta.push('v' + body.version); meta.push(body.acceptances + ' 人已接收') } else meta.push('尚未配置')
      document.getElementById('sharedMeta').textContent = meta.join(' · ')
    } catch {
      document.getElementById('sharedMeta').textContent = '加载失败'
    }
  }

  document.getElementById('saveSharedBtn').addEventListener('click', async (event) => {
    const btn = event.currentTarget
    if (btn.disabled) return
    msg.textContent = ''
    msg.className = 'msg'
    const providers = {}, credentials = {}
    for (const card of provBox.querySelectorAll('.prov-card')) {
      const entry = card._read()
      if (entry) providers[entry.route] = entry.profile
    }
    for (const tr of credBody.querySelectorAll('tr')) {
      const { ref, key } = tr._read()
      if (ref && key) credentials[ref] = key
    }
    // 防重复提交：双击不会连发两次 PUT（版本号跳两版 + 两次提示）。
    btn.disabled = true
    try {
      const res = await fetch('/api/admin/shared-config', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ payload: { providers, credentials } }),
      })
      if (res.ok) {
        msg.textContent = '已保存（v' + (await res.json()).version + '）；已接收的用户会看到更新提示'
        await loadShared()
        if (onSaved) await onSaved()
      } else {
        const e = await res.json().catch(() => ({}))
        msg.textContent = '保存失败：' + (e.detail || e.error || res.status)
        msg.classList.add('err')
      }
    } catch {
      msg.textContent = '保存失败：网络错误'
      msg.classList.add('err')
    } finally {
      btn.disabled = false
    }
  })

  return { loadShared }
}
