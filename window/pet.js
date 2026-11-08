/* global pet */
(() => {
  const petEl = document.getElementById('pet')
  const panelEl = document.getElementById('panel')
  const panelTitle = document.getElementById('panel-title')
  const panelBody = document.getElementById('panel-body')
  const menuEl = document.getElementById('menu')
  const pillEl = document.getElementById('mode-pill')
  const toastEl = document.getElementById('toast')

  const api = window.pet ?? {
    onState() {},
    onEvent() {},
    onAssets() {},
    onDragEnded() {},
    send() {},
    setShape() {},
    dragStart() {},
    dragEnd() {},
  }

  const MODES = [
    { id: 'status', label: '工作状态' },
    { id: 'tokens', label: 'Token 余量' },
    { id: 'chat', label: '快速对话' },
  ]

  const PANEL_TTL = 3000

  let state = null
  let assets = null
  let modeIndex = 0
  let openMode = null
  let draft = ''
  let sending = false
  let toastTimer = null
  let pillTimer = null
  let hideTimer = null
  let petSilhouette = []
  let pressed = null

  const anim = { name: null, frame: 0, last: 0, acc: 0 }

  // ── formatting ──────────────────────────────────────────────────────────
  const isNum = (value) => typeof value === 'number' && Number.isFinite(value)

  function formatCount(value) {
    if (!isNum(value)) return '—'
    const abs = Math.abs(value)
    if (abs < 1000) return String(Math.round(value))
    if (abs < 1e6) return `${(value / 1e3).toFixed(abs < 1e4 ? 1 : 0)}K`
    return `${(value / 1e6).toFixed(abs < 1e7 ? 1 : 0)}M`
  }

  function formatMoney(wallet) {
    if (!wallet || !isNum(Number(wallet.amount))) return null
    const amount = Number(wallet.amount)
    const symbol = wallet.currency === 'USD' ? '$' : '¥'
    const digits = amount >= 100 ? 0 : 2
    return `${symbol}${amount.toFixed(digits)}`
  }

  function formatBonus(wallet) {
    if (!wallet || !isNum(Number(wallet.bonus))) return null
    const amount = Number(wallet.bonus)
    if (!(amount > 0)) return null
    return `${wallet.currency === 'USD' ? '$' : '¥'}${amount.toFixed(2)}`
  }

  function formatAgo(timestamp) {
    if (!isNum(timestamp) || timestamp <= 0) return '—'
    const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000))
    if (seconds < 60) return '刚刚'
    if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`
    return `${Math.floor(seconds / 3600)} 小时前`
  }

  const escapeHtml = (text) =>
    String(text ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch])

  function baseState() {
    if (!state || !state.session) return 'idle'
    if (state.session.pending) return 'waiting'
    if (state.session.running) return 'working'
    return 'idle'
  }

  const currentMode = () => MODES[modeIndex].id

  // ── sprite animation ────────────────────────────────────────────────────
  function renderFrame() {
    if (!assets || !anim.name) return
    const def = assets.states[anim.name]
    if (!def) return
    petEl.style.backgroundImage = `url(${def.url})`
    petEl.style.backgroundPosition = `${-anim.frame * assets.frameWidth}px 0`
    petEl.style.backgroundSize = `${assets.frameWidth * def.frames}px ${assets.frameHeight}px`
  }

  function play(name) {
    if (!assets || !assets.states[name]) return
    if (anim.name === name) return
    anim.name = name
    anim.frame = 0
    anim.acc = 0
    renderFrame()
  }

  /** Squash in place: no jump, just a quick flatten and settle back. */
  function squash() {
    petEl.classList.remove('squash')
    void petEl.offsetWidth
    petEl.classList.add('squash')
  }

  petEl.addEventListener('animationend', (event) => {
    if (event.animationName === 'pet-squash') petEl.classList.remove('squash')
  })

  function tick(timestamp) {
    requestAnimationFrame(tick)
    if (!assets || !anim.name) return
    const def = assets.states[anim.name]
    if (!def) return
    const delta = anim.last > 0 ? timestamp - anim.last : 16
    anim.last = timestamp
    anim.acc += delta
    const frameMs = 1000 / (def.fps || 8)
    while (anim.acc >= frameMs) {
      anim.acc -= frameMs
      if (anim.frame + 1 >= def.frames) {
        if (def.loop) {
          anim.frame = 0
        } else {
          anim.name = null
          anim.last = 0
          play(baseState())
          break
        }
      } else {
        anim.frame += 1
      }
    }
    renderFrame()
  }

  // ── shaped window ───────────────────────────────────────────────────────
  function windowRect(element, inflate = 0) {
    const rect = element.getBoundingClientRect()
    return {
      x: Math.round(rect.left - inflate),
      y: Math.round(rect.top - inflate),
      width: Math.round(rect.width + inflate * 2),
      height: Math.round(rect.height + inflate * 2),
    }
  }

  const pillVisible = () => pillEl.classList.contains('show')

  /**
   * The pet's alpha silhouette is sent to the main process, which polls the
   * cursor against it: only pixels that belong to the drawn pet take the mouse.
   * While a popup is open the whole window is interactive (so buttons and
   * outside clicks work).
   */
  function applyWindowShape() {
    api.setShape(petSilhouette)
    api.setOverlay(!menuEl.hidden || openMode !== null || pillVisible() || !toastEl.hidden)
  }

  /** Union of the idle frames' alpha channel, quantised to 4px rows. */
  async function computeSilhouette() {
    if (!assets) return
    const stateDef = assets.states.idle ?? Object.values(assets.states)[0]
    if (!stateDef) return
    const fw = assets.frameWidth
    const fh = assets.frameHeight
    const canvas = document.createElement('canvas')
    canvas.width = fw
    canvas.height = fh
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    const mask = new Uint8Array(fw * fh)

    for (let index = 0; index < Math.max(1, stateDef.frames); index += 1) {
      try {
        const image = new Image()
        image.src = stateDef.url
        await image.decode()
        ctx.clearRect(0, 0, fw, fh)
        ctx.drawImage(image, index * fw, 0, fw, fh, 0, 0, fw, fh)
        const data = ctx.getImageData(0, 0, fw, fh).data
        for (let p = 0; p < fw * fh; p += 1) {
          if (data[p * 4 + 3] > 24) mask[p] = 1
        }
      } catch {
        /* skip an undecodable frame */
      }
    }

    const box = petEl.getBoundingClientRect()
    const scaleX = box.width / fw
    const scaleY = box.height / fh
    const step = 4
    const rects = []
    for (let y = 0; y < fh; y += step) {
      let start = -1
      for (let x = 0; x <= fw; x += step) {
        let on = false
        if (x < fw) {
          for (let yy = y; yy < Math.min(y + step, fh) && !on; yy += 1) {
            for (let xx = x; xx < Math.min(x + step, fw); xx += 1) {
              if (mask[yy * fw + xx] === 1) {
                on = true
                break
              }
            }
          }
        }
        if (on && start < 0) start = x
        else if (!on && start >= 0) {
          rects.push({
            x: Math.round(box.left + start * scaleX),
            y: Math.round(box.top + y * scaleY),
            width: Math.max(1, Math.round((x - start) * scaleX)),
            height: Math.max(1, Math.round(step * scaleY)),
          })
          start = -1
        }
      }
    }
    petSilhouette = rects
    applyWindowShape()
  }

  // ── panels ──────────────────────────────────────────────────────────────
  function statusBody() {
    if (!state || !state.session) {
      return '<div class="empty">还没有打开的会话。<br />在 dsh 里打开或新建一个会话，桌宠会自动跟随。</div>'
    }
    const session = state.session
    const label = session.pending ? '待你确认' : session.running ? '工作中' : '待命中'
    return `
      <div class="row"><span>会话</span><b title="${escapeHtml(session.title)}">${escapeHtml(session.title || '未命名会话')}</b></div>
      <div class="row"><span>状态</span><b>${label}</b></div>
      <div class="row"><span>更新</span><b>${formatAgo(state.updatedAt)}</b></div>
      <div class="actions">
        <button class="btn danger" data-action="cancel" ${session.running ? '' : 'disabled'}>停止本回合</button>
      </div>`
  }

  function tokensBody() {
    const tokens = (state && state.tokens) || {}
    const wallet = state && state.balance
    const money = formatMoney(wallet)
    const bonus = formatBonus(wallet)
    const windowTokens = tokens.contextWindow
    const used = tokens.used
    const remaining = isNum(windowTokens) && isNum(used) ? Math.max(0, windowTokens - used) : null
    const percent = isNum(windowTokens) && isNum(used) && windowTokens > 0 ? Math.min(100, (used / windowTokens) * 100) : null
    const rate = percent === null ? '' : percent >= 95 ? ' full' : percent >= 80 ? ' hot' : ''
    const usage = [
      ['输入', tokens.input],
      ['输出', tokens.output],
      ['缓存读取', tokens.cacheRead],
      tokens.cacheWrite ? ['缓存写入', tokens.cacheWrite] : null,
    ].filter(Boolean)

    return `
      <div class="label">账户余额</div>
      <div class="hero">${money ?? '—'}</div>
      ${bonus ? `<div class="muted">赠送余额 ${bonus}</div>` : ''}
      ${
        remaining === null
          ? `<div class="empty" style="padding-top:10px">${state && state.session ? '本次会话还没有可计量的请求。' : '打开会话后可查看上下文余量。'}</div>`
          : `<div class="bar"><i class="${rate.trim()}" style="width:${percent}%"></i></div>
             <div class="row"><span>上下文剩余</span><b>${formatCount(remaining)}</b></div>
             <div class="row"><span>已用 / 窗口</span><b>${formatCount(used)} / ${formatCount(windowTokens)}</b></div>
             <div class="muted">占用 ${percent.toFixed(0)}%</div>`
      }
      ${
        usage.length > 0
          ? `<div class="grid">${usage.map(([label, value]) => `<span>${label}</span><b>${formatCount(value)}</b>`).join('')}</div>`
          : ''
      }`
  }

  function chatBody() {
    if (!state || !state.session) {
      return '<div class="empty">请先在 dsh 里打开一个会话。</div>'
    }
    return `
      <textarea id="chat-input" placeholder="给当前会话发消息…" spellcheck="false">${escapeHtml(draft)}</textarea>
      <div class="actions">
        <button class="btn primary" data-action="send" ${sending ? 'disabled' : ''}>${sending ? '发送中…' : '发送'}</button>
        <button class="btn danger" data-action="cancel" ${state.session.running ? '' : 'disabled'}>停止</button>
      </div>
      <div class="hint">Enter 发送，Shift+Enter 换行</div>`
  }

  function renderPanel() {
    if (openMode === null) return
    const input = document.getElementById('chat-input')
    if (openMode === 'chat' && input !== null && document.activeElement === input) return
    panelTitle.textContent = (MODES.find((item) => item.id === openMode) ?? { label: openMode }).label
    panelBody.innerHTML = openMode === 'status' ? statusBody() : openMode === 'tokens' ? tokensBody() : chatBody()
  }

  function hidePill() {
    clearTimeout(pillTimer)
    pillEl.classList.remove('show')
    applyWindowShape()
  }

  function showPill() {
    const mode = MODES[modeIndex]
    pillEl.textContent = `${mode.label} · 左键打开`
    pillEl.classList.add('show')
    clearTimeout(pillTimer)
    pillTimer = setTimeout(() => {
      pillEl.classList.remove('show')
      applyWindowShape()
    }, 1600)
    applyWindowShape()
  }

  function scheduleHide() {
    clearTimeout(hideTimer)
    hideTimer = setTimeout(() => closePanel(), PANEL_TTL)
  }

  function updateMenuActive() {
    for (const item of menuEl.querySelectorAll('[data-mode]')) {
      item.dataset.active = item.dataset.mode === currentMode() ? 'true' : 'false'
    }
  }

  function openPanel(next) {
    openMode = next
    panelEl.hidden = false
    hidePill()
    renderPanel()
    applyWindowShape()
    scheduleHide()
    if (next === 'chat') {
      const input = document.getElementById('chat-input')
      if (input !== null) input.focus()
    }
  }

  function closePanel() {
    clearTimeout(hideTimer)
    hideTimer = null
    openMode = null
    panelEl.hidden = true
    applyWindowShape()
  }

  function openMenu() {
    closePanel()
    updateMenuActive()
    menuEl.hidden = false
    hidePill()
    applyWindowShape()
  }

  function closeMenu() {
    menuEl.hidden = true
    applyWindowShape()
  }

  function selectMode(index) {
    modeIndex = index
    updateMenuActive()
    closeMenu()
    showPill()
  }

  function showToast(message) {
    toastEl.textContent = message
    toastEl.hidden = false
    applyWindowShape()
    clearTimeout(toastTimer)
    toastTimer = setTimeout(() => {
      toastEl.hidden = true
      applyWindowShape()
    }, 3200)
  }

  // ── host messages ───────────────────────────────────────────────────────
  function applyState(next) {
    state = next
    if (!state) return
    play(baseState())
    if (openMode !== null) renderPanel()
  }

  function applyEvent(message) {
    if (!message) return
    if (message.type === 'sent') {
      sending = false
      draft = ''
      if (openMode === 'chat') renderPanel()
      showToast('已发送')
      scheduleHide()
    } else if (message.type === 'toast') {
      sending = false
      showToast(message.message || '操作失败')
      if (openMode !== null) renderPanel()
      scheduleHide()
    }
  }

  // ── input ───────────────────────────────────────────────────────────────
  function sendChat() {
    const text = draft.trim()
    if (!text || sending) return
    sending = true
    api.send({ type: 'chat', text })
    renderPanel()
  }

  function activatePet() {
    squash()
    if (menuEl.hidden === false) closeMenu()
    if (openMode !== null) {
      scheduleHide()
      return
    }
    openPanel(currentMode())
  }

  function pointerMoved(event) {
    if (pressed === null) return false
    return Math.abs(event.screenX - pressed.startX) + Math.abs(event.screenY - pressed.startY) > 4
  }

  petEl.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return
    event.preventDefault()
    pressed = { startX: event.screenX, startY: event.screenY, moved: false, dist: 0 }
    // Start tracking immediately: the pet follows the cursor 1:1 from the
    // first pixel instead of losing the movement threshold distance.
    api.dragStart()
    try {
      petEl.setPointerCapture(event.pointerId)
    } catch {
      /* ignore */
    }
  })

  petEl.addEventListener('pointermove', (event) => {
    if (pressed === null) return
    if ((event.buttons & 1) === 0) return
    pressed.dist += Math.abs(event.movementX) + Math.abs(event.movementY)
    if (!pressed.moved && pressed.dist > 4) pressed.moved = true
    api.dragMove()
  })

  window.addEventListener(
    'pointerup',
    () => {
      if (pressed === null) return
      const moved = pressed.moved
      pressed = null
      api.dragEnd()
      if (!moved) activatePet()
    },
    true,
  )

  // Do NOT end the drag on blur/pointercancel: moving or focusing the window
  // can emit them mid-drag, which stopped the pet after the first step.

  petEl.addEventListener('contextmenu', (event) => {
    event.preventDefault()
    if (menuEl.hidden) openMenu()
    else closeMenu()
  })

  menuEl.addEventListener('click', (event) => {
    const item = event.target.closest('[data-mode]')
    if (item === null) return
    const index = MODES.findIndex((mode) => mode.id === item.dataset.mode)
    if (index >= 0) selectMode(index)
  })

  document.getElementById('panel-close').addEventListener('click', closePanel)

  panelBody.addEventListener('click', (event) => {
    const button = event.target.closest('[data-action]')
    if (button === null) return
    if (button.dataset.action === 'cancel') api.send({ type: 'cancel' })
    if (button.dataset.action === 'send') sendChat()
  })

  panelBody.addEventListener('input', (event) => {
    if (event.target.id === 'chat-input') {
      draft = event.target.value
      scheduleHide()
    }
  })

  panelBody.addEventListener('keydown', (event) => {
    if (event.target.id !== 'chat-input') return
    scheduleHide()
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault()
      sendChat()
    }
  })

  panelEl.addEventListener('pointerdown', scheduleHide)

  document.addEventListener('pointerdown', (event) => {
    if (event.target.closest('.panel, .menu, .pet')) return
    api.dragEnd()
    closeMenu()
    closePanel()
  })

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      closeMenu()
      closePanel()
    }
  })

  api.onAssets((next) => {
    assets = next
    play(baseState())
    void computeSilhouette()
  })

  // If the window is ever resized (DPI change, OS adjusting the frame), the
  // pet moves with right/bottom anchoring; the hit silhouette must follow it.
  window.addEventListener('resize', () => {
    void computeSilhouette()
  })

  api.onState((next) => applyState(next))
  api.onEvent((message) => applyEvent(message))

  updateMenuActive()
  applyWindowShape()
  requestAnimationFrame(tick)
})()
