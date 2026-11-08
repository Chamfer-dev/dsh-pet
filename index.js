/**
 * dsh-pet — host half.
 *
 * Runs inside the dsh Host process and owns one companion Electron window:
 * a transparent, always-on-top pet that stays on the desktop while dsh is in
 * the background.
 *
 * Transport: one loopback TCP socket (random port, one-time token) carries
 * newline-delimited JSON both ways. A GUI Electron process cannot use stdin
 * for this, so the window connects back to the Host instead.
 *
 *   Host   -> window : {"type":"state","state":{...}} / {"type":"toast",...}
 *   window -> Host   : {"type":"chat","text":"..."} / {"type":"cancel"}
 *
 * The window lives in `window/` and is launched with the Electron runtime in
 * `../pet-runtime`; set DSH_PET_ELECTRON to override its path.
 */
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const WINDOW_DIR = path.join(here, 'window')

function safe(fn) {
  try {
    return fn()
  } catch {
    return undefined
  }
}

function findElectron() {
  const home = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
  const exe =
    process.platform === 'win32'
      ? 'electron.exe'
      : process.platform === 'darwin'
        ? 'Electron.app/Contents/MacOS/Electron'
        : 'electron'
  const candidates = [
    process.env.DSH_PET_ELECTRON,
    path.join(here, 'runtime', exe),
    path.join(here, 'node_modules', 'electron', 'dist', exe),
    path.join(here, '..', 'pet-runtime', 'node_modules', 'electron', 'dist', exe),
    path.join(home, 'dsh-pet', 'runtime', exe),
    path.join(home, 'dsh-pet', 'runtime', 'electron', exe),
  ]
  for (const candidate of candidates) {
    if (candidate !== undefined && fs.existsSync(candidate)) return candidate
  }
  return undefined
}

export function apply(ctx) {
  const home = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
  const stateDir = path.join(home, 'dsh-pet')
  const logFile = path.join(stateDir, 'pet.log')

  const log = (line) => {
    try {
      fs.mkdirSync(stateDir, { recursive: true })
      fs.appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`)
    } catch {
      /* logging is best-effort */
    }
  }

  const electron = findElectron()
  if (electron === undefined) {
    log('electron runtime not found; set DSH_PET_ELECTRON to electron.exe')
    return
  }
  log(`activating with ${electron}`)

  const clientMeta = {
    version: process.env.DSH_CLIENT_VERSION ?? '0.2.1-rc.3',
    locale: 'zh-CN',
    timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
  }
  const token = crypto.randomBytes(18).toString('hex')

  let child = null
  let socket = null
  let server = null
  let port = null
  let disposed = false
  let restarts = 0
  let balance = null
  let stateTimer = null
  let balanceTimer = null

  const send = (message) => {
    if (socket === null || socket.destroyed || !socket.writable) return
    try {
      socket.write(`${JSON.stringify(message)}\n`)
    } catch {
      /* the close handler owns socket loss */
    }
  }

  const agentsOf = () => {
    const agents = ctx.get('agents')
    return agents !== undefined && typeof agents.list === 'function' ? agents.list() : []
  }

  const currentAgent = () => {
    const list = agentsOf()
    if (list.length === 0) return undefined
    const running = list.filter((agent) => safe(() => agent.status) === 'running')
    return running[running.length - 1] ?? list[list.length - 1]
  }

  const collect = () => {
    const agent = currentAgent()
    const session = agent === undefined ? undefined : safe(() => agent.session)
    const projections = ctx.get('sessionProjections')
    const title = session === undefined ? undefined : safe(() => projections.stateOf(session, 'title'))
    const usage = session === undefined ? undefined : safe(() => projections.stateOf(session, 'tokenUsage'))
    const pressure = session === undefined ? undefined : safe(() => projections.stateOf(session, 'contextPressure'))
    const status = agent === undefined ? undefined : safe(() => agent.status)

    return {
      session:
        session === undefined
          ? null
          : {
              id: safe(() => agent.id) ?? null,
              title: typeof title === 'string' ? title : '',
              running: status === 'running',
              pending: false,
            },
      tokens: {
        contextWindow: safe(() => pressure.contextWindow) ?? null,
        used: safe(() => pressure.pressureTokens) ?? null,
        surface: safe(() => pressure.surfaceTokens) ?? null,
        input: safe(() => usage.totals.uncachedInputTokens) ?? null,
        output: safe(() => usage.totals.outputTokens) ?? null,
        cacheRead: safe(() => usage.totals.cacheReadTokens) ?? null,
        cacheWrite: safe(() => usage.totals.cacheWriteTokens) ?? null,
      },
      balance,
      updatedAt: Date.now(),
    }
  }

  const refreshBalance = async () => {
    const account = ctx.get('deepseekAccount')
    if (account === undefined || typeof account.getBalance !== 'function') return
    try {
      const result = await account.getBalance(clientMeta)
      if (result === null || result === undefined || result.status !== 'ready') {
        balance = null
        return
      }
      const normal = Array.isArray(result.value) ? result.value[0] : undefined
      const bonus = Array.isArray(result.bonusWallets) ? result.bonusWallets[0] : undefined
      if (normal === undefined) {
        balance = null
        return
      }
      balance = {
        currency: normal.currency,
        amount: Number(normal.balance),
        bonus: bonus === undefined ? null : Number(bonus.balance),
      }
    } catch (error) {
      log(`balance failed: ${error.message}`)
    }
  }

  const chat = async (text) => {
    const agent = currentAgent()
    if (agent === undefined) {
      send({ type: 'toast', message: '当前没有可用的会话' })
      return
    }
    try {
      await agent.followup({ content: [{ type: 'text', text }], source: { kind: 'user' } })
      send({ type: 'sent' })
    } catch (error) {
      log(`chat failed: ${error.message}`)
      send({ type: 'toast', message: `发送失败：${error.message}` })
    }
  }

  const cancel = () => {
    const agent = currentAgent()
    if (agent === undefined) return
    try {
      agent.cancel({ kind: 'user' })
    } catch (error) {
      log(`cancel failed: ${error.message}`)
    }
  }

  const handle = (message) => {
    if (!message || typeof message !== 'object') return
    if (message.type === 'chat') void chat(String(message.text ?? ''))
    else if (message.type === 'cancel') cancel()
    else if (message.type === 'log') log(`window: ${message.message}`)
  }

  const start = () => {
    if (port === null || disposed) return
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    env.DSH_PET_DEBUG = path.join(stateDir, 'window.log')
    child = spawn(electron, [WINDOW_DIR, '--pet-port', String(port), '--pet-token', token], {
      cwd: WINDOW_DIR,
      stdio: 'ignore',
      windowsHide: true,
      env,
    })

    child.on('error', (error) => log(`spawn failed: ${error.message}`))
    child.on('exit', (code) => {
      child = null
      socket = null
      log(`window exited (${code})`)
      if (disposed || restarts >= 5) return
      restarts += 1
      setTimeout(() => {
        if (!disposed && child === null) start()
      }, 3000)
    })
  }

  server = net.createServer((connection) => {
    connection.setEncoding('utf8')
    let authed = false
    const lines = readline.createInterface({ input: connection })
    lines.on('line', (line) => {
      let message
      try {
        message = JSON.parse(line)
      } catch {
        return
      }
      if (!authed) {
        if (message.type === 'hello' && message.token === token) {
          authed = true
          socket = connection
          log('window connected')
        } else {
          connection.destroy()
        }
        return
      }
      handle(message)
    })
    connection.on('error', () => {
      /* a dropped window reconnects through its restart path */
    })
    connection.on('close', () => {
      if (socket === connection) socket = null
    })
  })

  server.on('error', (error) => log(`server failed: ${error.message}`))
  server.listen(0, '127.0.0.1', () => {
    port = server.address().port
    log(`listen on 127.0.0.1:${port}`)
    start()
  })

  stateTimer = setInterval(() => {
    send({ type: 'state', state: collect() })
  }, 900)

  void refreshBalance()
  balanceTimer = setInterval(() => void refreshBalance(), 60000)

  ctx.effect(
    () => () => {
      disposed = true
      if (stateTimer !== null) clearInterval(stateTimer)
      if (balanceTimer !== null) clearInterval(balanceTimer)
      stateTimer = null
      balanceTimer = null
      if (socket !== null) {
        try {
          socket.destroy()
        } catch {
          /* ignore */
        }
        socket = null
      }
      if (server !== null) {
        try {
          server.close()
        } catch {
          /* ignore */
        }
        server = null
      }
      if (child !== null) {
        try {
          child.kill()
        } catch {
          /* ignore */
        }
        child = null
      }
      log('disposed')
    },
    'dsh-pet: companion window',
  )
}
