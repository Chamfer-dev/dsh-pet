/**
 * The pet window process.
 *
 * Started by the dsh-pet Host plugin through the Electron runtime in
 * `../pet-runtime`. It owns one transparent, frameless, always-on-top window
 * and talks to the Host over one loopback TCP socket (newline-delimited JSON).
 *
 * Hit testing: the window is shaped with `win.setShape()` to the pet's actual
 * alpha silhouette (plus any visible popup rects). Fully transparent pixels are
 * not part of the window, so clicks beside the pet go straight to the desktop.
 * No `setIgnoreMouseEvents` polling is involved.
 *
 * Dragging: the renderer only reports "drag started"; the main process moves
 * the window from the global cursor and stops when `GetAsyncKeyState` says the
 * physical left button is up. A lost pointerup therefore cannot leave the pet
 * following the mouse.
 */
const { app, BrowserWindow, ipcMain, screen } = require('electron')
const fs = require('node:fs')
const net = require('node:net')
const path = require('node:path')
const readline = require('node:readline')

const WINDOW = { width: 352, height: 540 }
const PET = { left: 184, top: 372, size: 160 }

let win = null
let quitRequested = false
let shapeRects = null
let dragActive = false
let dragTimer = null
let dragOrigin = null
let assetWatcher = null
let assetTimer = null

function debug(line) {
  if (!process.env.DSH_PET_DEBUG) return
  try {
    fs.mkdirSync(path.dirname(process.env.DSH_PET_DEBUG), { recursive: true })
    fs.appendFileSync(process.env.DSH_PET_DEBUG, `${new Date().toISOString()} ${line}\n`)
  } catch {
    /* ignore */
  }
}

debug('main module loaded')

function emit(message) {
  debug(`emit: ${JSON.stringify(message)}`)
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function send(message) {
  if (win !== null && !win.isDestroyed()) win.webContents.send('pet:state', message.state)
}

function statePath() {
  return path.join(app.getPath('userData'), 'window-state.json')
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(statePath(), 'utf8'))
  } catch {
    return {}
  }
}

function writeState(patch) {
  try {
    const next = { ...readState(), ...patch }
    fs.mkdirSync(path.dirname(statePath()), { recursive: true })
    fs.writeFileSync(statePath(), JSON.stringify(next))
  } catch {
    /* persistence is best-effort */
  }
}

/** Keep the whole window inside one display's work area. */
function clampWindow(x, y) {
  const area = screen.getDisplayNearestPoint({
    x: Math.round(x + WINDOW.width / 2),
    y: Math.round(y + WINDOW.height / 2),
  }).workArea
  const maxX = Math.max(area.x, area.x + area.width - WINDOW.width)
  const maxY = Math.max(area.y, area.y + area.height - WINDOW.height)
  return {
    x: Math.min(Math.max(area.x, Math.round(x)), maxX),
    y: Math.min(Math.max(area.y, Math.round(y)), maxY),
  }
}

function defaultWindowPosition() {
  const area = screen.getPrimaryDisplay().workArea
  return clampWindow(area.x + area.width - WINDOW.width, area.y + area.height - WINDOW.height)
}

let pollTimer = null
let ignoring = null
let interactive = false

function setIgnoring(value) {
  if (win === null || win.isDestroyed() || ignoring === value) return
  ignoring = value
  win.setIgnoreMouseEvents(value, { forward: false })
  debug(`ignore-mouse ${value}`)
}

/**
 * Per-pixel hit testing without setShape. `setShape` resizes this layered
 * window a little on every call (the pet then creeps toward the corner), so we
 * instead poll the global cursor against the pet's alpha silhouette that the
 * renderer reports. The window itself never changes size or region.
 */
function startHitPoll() {
  if (pollTimer !== null) return
  pollTimer = setInterval(() => {
    if (win === null || win.isDestroyed()) return
    if (interactive || dragActive) {
      setIgnoring(false)
      return
    }
    const cursor = screen.getCursorScreenPoint()
    const content = win.getContentBounds()
    let inside = false
    if (shapeRects !== null) {
      for (const rect of shapeRects) {
        if (
          cursor.x >= content.x + rect.x &&
          cursor.x < content.x + rect.x + rect.width &&
          cursor.y >= content.y + rect.y &&
          cursor.y < content.y + rect.y + rect.height
        ) {
          inside = true
          break
        }
      }
    }
    setIgnoring(!inside)
  }, 25)
}

let getAsyncKeyState = null
let buttonTimer = null
let buttonUpTicks = 0

function loadKoffi() {
  try {
    return require('koffi')
  } catch {
    try {
      return require(path.join(__dirname, '..', '..', 'pet-runtime', 'node_modules', 'koffi'))
    } catch {
      return null
    }
  }
}

function leftButtonDown() {
  try {
    if (getAsyncKeyState === null) {
      const koffi = loadKoffi()
      if (koffi === null) return true
      const user32 = koffi.load('user32.dll')
      getAsyncKeyState = user32.func('short __stdcall GetAsyncKeyState(int)')
    }
    return (getAsyncKeyState(0x01) & 0x8000) !== 0
  } catch {
    return true
  }
}

/**
 * The renderer's pointerup is not always delivered (moving/shaping a layered
 * window can cancel the pointer). This watchdog reads the physical left button
 * and ends the drag after it has been up for two consecutive ticks, so a lost
 * pointerup can never leave the pet following the mouse.
 */
function startButtonWatch() {
  stopButtonWatch()
  buttonUpTicks = 0
  buttonTimer = setInterval(() => {
    if (dragOrigin === null) {
      stopButtonWatch()
      return
    }
    if (leftButtonDown()) {
      buttonUpTicks = 0
      return
    }
    buttonUpTicks += 1
    if (buttonUpTicks >= 2) {
      debug('button released (watchdog)')
      endDrag()
    }
  }, 50)
}

function stopButtonWatch() {
  if (buttonTimer !== null) {
    clearInterval(buttonTimer)
    buttonTimer = null
  }
  buttonUpTicks = 0
}

/**
 * While dragging, the window keeps a full-window shape so the pointer never
 * leaves it and pointermove/pointerup keep arriving. Positions come from the
 * global cursor (not from moving-window-relative event coordinates) and are
 * applied with Electron's DIP-aware `setPosition`; using native SetWindowPos
 * here would mix physical pixels with DIP and make the pet fall behind.
 */
function startDrag() {
  if (win === null || win.isDestroyed()) return
  const [x, y] = win.getPosition()
  const cursor = screen.getCursorScreenPoint()
  const area = screen.getDisplayNearestPoint({
    x: x + Math.round(WINDOW.width / 2),
    y: y + Math.round(WINDOW.height / 2),
  }).workArea
  dragOrigin = {
    x,
    y,
    cursorX: cursor.x,
    cursorY: cursor.y,
    lastX: x,
    lastY: y,
    minX: area.x,
    minY: area.y,
    maxX: Math.max(area.x, area.x + area.width - WINDOW.width),
    maxY: Math.max(area.y, area.y + area.height - WINDOW.height),
  }
  dragActive = true
  setIgnoring(false)
  startButtonWatch()
  debug(`drag start win=${x},${y} cursor=${cursor.x},${cursor.y}`)
}

function moveDrag() {
  if (dragOrigin === null || win === null || win.isDestroyed()) return
  const cursor = screen.getCursorScreenPoint()
  const x = Math.min(Math.max(dragOrigin.minX, dragOrigin.x + cursor.x - dragOrigin.cursorX), dragOrigin.maxX)
  const y = Math.min(Math.max(dragOrigin.minY, dragOrigin.y + cursor.y - dragOrigin.cursorY), dragOrigin.maxY)
  if (x === dragOrigin.lastX && y === dragOrigin.lastY) return
  dragOrigin.lastX = x
  dragOrigin.lastY = y
  // setBounds (not setPosition): a plain setPosition on a content-sized
  // layered window grows it by ~1px per call, which made the pet creep.
  win.setBounds({ x, y, width: WINDOW.width, height: WINDOW.height }, false)
}

function endDrag() {
  if (dragOrigin === null) return
  dragOrigin = null
  dragActive = false
  stopButtonWatch()
  if (win === null || win.isDestroyed()) return
  const [lastX, lastY] = win.getPosition()
  writeState({ position: { x: lastX, y: lastY } })
  debug(`drag end ${lastX},${lastY}`)
  win.webContents.send('pet:drag-ended')
}

function quit() {
  if (quitRequested) return
  quitRequested = true
  app.quit()
}

function loadAssets() {
  const base = path.join(__dirname, 'assets')
  const manifest = JSON.parse(fs.readFileSync(path.join(base, 'pet.json'), 'utf8'))
  const states = {}
  for (const [name, def] of Object.entries(manifest.states ?? {})) {
    try {
      const bytes = fs.readFileSync(path.join(base, def.image))
      states[name] = { ...def, url: `data:image/png;base64,${bytes.toString('base64')}` }
    } catch (error) {
      emit({ type: 'log', message: `asset ${name} missing: ${error.message}` })
    }
  }
  return {
    frameWidth: manifest.frameWidth,
    frameHeight: manifest.frameHeight,
    scale: manifest.scale ?? 1,
    states,
  }
}

/** Re-read sprite strips when the artist saves new PNGs. */
function watchAssets() {  if (assetWatcher !== null) return
  try {
    assetWatcher = fs.watch(path.join(__dirname, 'assets'), { persistent: false }, () => {
      clearTimeout(assetTimer)
      assetTimer = setTimeout(() => {
        try {
          win.webContents.send('pet:assets', loadAssets())
        } catch (error) {
          emit({ type: 'log', message: `assets reload failed: ${error.message}` })
        }
      }, 400)
    })
  } catch {
    /* watching is a convenience */
  }
}

/** Dev aid: `capture.request` in userData triggers one window screenshot. */
function watchCaptureRequests() {
  setInterval(async () => {
    const request = path.join(app.getPath('userData'), 'capture.request')
    if (!fs.existsSync(request)) return
    try {
      fs.unlinkSync(request)
    } catch {
      return
    }
    try {
      const image = await win.capturePage()
      fs.writeFileSync(path.join(app.getPath('userData'), 'capture.png'), image.toPNG())
      debug('capture request served')
    } catch (error) {
      debug(`capture request failed: ${error.message}`)
    }
  }, 1200)
}

function wireIpc() {
  ipcMain.on('pet:out', (_event, message) => emit(message))
  ipcMain.on('pet:shape', (_event, rects) => {
    if (Array.isArray(rects) && rects.length > 0) {
      shapeRects = rects
      debug(`shape rects=${rects.length}`)
    }
  })
  ipcMain.on('pet:overlay', (_event, open) => {
    interactive = Boolean(open)
    if (interactive) setIgnoring(false)
  })
  ipcMain.on('pet:drag-start', () => startDrag())
  ipcMain.on('pet:drag-move', () => moveDrag())
  ipcMain.on('pet:drag-end', () => endDrag())
  ipcMain.on('pet:quit', quit)
}

function argValue(flag) {
  const index = process.argv.indexOf(flag)
  return index >= 0 ? process.argv[index + 1] : undefined
}

/** Host link: the window opens the TCP connection and says hello first. */
function wireHost() {
  const port = Number(argValue('--pet-port'))
  const token = argValue('--pet-token') ?? ''
  if (!Number.isInteger(port) || port <= 0) {
    debug('no host port; standalone window')
    return
  }

  const connection = net.connect({ host: '127.0.0.1', port }, () => {
    connection.write(`${JSON.stringify({ type: 'hello', token })}\n`)
    debug('host connected')
  })
  connection.setEncoding('utf8')

  const lines = readline.createInterface({ input: connection })
  lines.on('line', (line) => {
    let message
    try {
      message = JSON.parse(line)
    } catch {
      return
    }
    if (!message) return
    if (message.type === 'state') send(message)
    else if (win !== null && !win.isDestroyed()) win.webContents.send('pet:event', message)
  })

  connection.on('close', quit)
  connection.on('error', quit)
}

app.whenReady().then(() => {
  const saved = readState()
  const fallback = defaultWindowPosition()
  const start = clampWindow(
    Number.isFinite(saved.position && saved.position.x) ? saved.position.x : fallback.x,
    Number.isFinite(saved.position && saved.position.y) ? saved.position.y : fallback.y,
  )

  win = new BrowserWindow({
    width: WINDOW.width,
    height: WINDOW.height,
    x: start.x,
    y: start.y,
    frame: false,
    thickFrame: false,
    useContentSize: true,
    transparent: true,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    show: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: false,
      backgroundThrottling: false,
    },
  })

  win.setBounds({ x: start.x, y: start.y, width: WINDOW.width, height: WINDOW.height }, false)
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  setIgnoring(true)
  startHitPoll()
  watchCaptureRequests()

  win.once('ready-to-show', () => {
    win.showInactive()
    debug(`shown bounds=${JSON.stringify(win.getBounds())}`)
  })
  win.on('closed', quit)

  win.webContents.on('did-finish-load', () => {
    debug('did-finish-load')
    try {
      const payload = loadAssets()
      debug(`assets: ${Object.keys(payload.states).join(',')}`)
      win.webContents.send('pet:assets', payload)
    } catch (error) {
      emit({ type: 'log', message: `assets failed: ${error.message}` })
    }
    watchAssets()
  })
  win.webContents.on('did-fail-load', (_event, code, description) => {
    debug(`did-fail-load ${code} ${description}`)
  })
  win.webContents.on('console-message', (event, level, message) => {
    const text = typeof event === 'object' && event !== null && typeof event.message === 'string' ? event.message : message
    emit({ type: 'log', message: `renderer: ${text}` })
  })

  // Development aid: DSH_PET_CAPTURE=<png path> saves one window capture.
  if (process.env.DSH_PET_CAPTURE) {
    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        try {
          const image = await win.capturePage()
          fs.writeFileSync(process.env.DSH_PET_CAPTURE, image.toPNG())
        } catch (error) {
          emit({ type: 'log', message: `capture failed: ${error.message}` })
        }
        if (process.env.DSH_PET_CAPTURE_EXIT === '1') quit()
      }, Number(process.env.DSH_PET_CAPTURE_DELAY_MS ?? 1500))
    })
  }

  // Development aid: DSH_PET_DEBUG_JS=<expression> runs once after load.
  if (process.env.DSH_PET_DEBUG_JS) {
    win.webContents.once('did-finish-load', () => {
      setTimeout(() => {
        win.webContents.executeJavaScript(process.env.DSH_PET_DEBUG_JS).catch((error) => {
          emit({ type: 'log', message: `debug js failed: ${error.message}` })
        })
      }, 1500)
    })
  }

  wireIpc()
  wireHost()
  win.loadFile(path.join(__dirname, 'index.html'))
  debug('loading index.html')
})

app.on('window-all-closed', quit)
