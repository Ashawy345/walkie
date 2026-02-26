const net = require('net')
const path = require('path')
const os = require('os')
const { spawn } = require('child_process')
const fs = require('fs')

const IS_WINDOWS = process.platform === 'win32'
const WALKIE_DIR = process.env.WALKIE_DIR || path.join(os.homedir(), '.walkie')
const SOCKET_PATH = path.join(WALKIE_DIR, 'daemon.sock')  // Unix only
const PORT_FILE = path.join(WALKIE_DIR, 'daemon.port')    // Windows only
const PID_FILE = path.join(WALKIE_DIR, 'daemon.pid')

function getAddress() {
  if (IS_WINDOWS) {
    try {
      const port = parseInt(fs.readFileSync(PORT_FILE, 'utf8').trim(), 10)
      return { host: '127.0.0.1', port }
    } catch {
      return null
    }
  }
  return SOCKET_PATH
}

function connect() {
  return new Promise((resolve, reject) => {
    const addr = getAddress()
    if (addr === null) return reject(new Error('Daemon not running'))
    const sock = IS_WINDOWS
      ? net.connect(addr.port, addr.host)
      : net.connect(addr)
    sock.on('connect', () => resolve(sock))
    sock.on('error', reject)
  })
}

function sendCommand(sock, cmd, timeout = 60000) {
  return new Promise((resolve, reject) => {
    let buf = ''
    let timer
    if (timeout > 0) {
      timer = setTimeout(() => {
        sock.removeListener('data', onData)
        reject(new Error('Command timed out'))
      }, timeout)
    }

    const onData = (data) => {
      buf += data.toString()
      const idx = buf.indexOf('\n')
      if (idx !== -1) {
        if (timer) clearTimeout(timer)
        sock.removeListener('data', onData)
        try {
          resolve(JSON.parse(buf.slice(0, idx)))
        } catch (e) {
          reject(e)
        }
      }
    }
    sock.on('data', onData)
    sock.write(JSON.stringify(cmd) + '\n')
  })
}

function isProcessRunning(pid) {
  try { process.kill(pid, 0); return true } catch { return false }
}

async function ensureDaemon() {
  // Try connecting to existing daemon
  try {
    const sock = await connect()
    const resp = await sendCommand(sock, { action: 'ping' })
    sock.destroy()
    if (resp.ok) return
  } catch {}

  // Clean stale socket/port file and PID file before spawning
  try { fs.unlinkSync(IS_WINDOWS ? PORT_FILE : SOCKET_PATH) } catch {}
  try {
    const pid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10)
    if (!isProcessRunning(pid)) fs.unlinkSync(PID_FILE)
  } catch {}

  // Spawn daemon
  fs.mkdirSync(WALKIE_DIR, { recursive: true })

  const daemonScript = path.join(__dirname, 'daemon.js')
  const child = spawn(process.execPath, [daemonScript], {
    detached: true,
    stdio: 'ignore'
  })
  child.unref()

  // Poll until ready
  for (let i = 0; i < 50; i++) {
    await new Promise(r => setTimeout(r, 200))
    try {
      const sock = await connect()
      const resp = await sendCommand(sock, { action: 'ping' })
      sock.destroy()
      if (resp.ok) return
    } catch {}
  }

  throw new Error(`Failed to start walkie daemon. Check ${path.join(WALKIE_DIR, 'daemon.log')} for details`)
}

async function request(cmd, timeout) {
  await ensureDaemon()
  const sock = await connect()
  const resp = await sendCommand(sock, cmd, timeout)
  sock.destroy()
  return resp
}

async function streamMessages(channel, secret, clientId, abort, onMessage, persist) {
  while (!abort.aborted) {
    try {
      const sock = await connect()
      abort.socket = sock

      const resp = await sendCommand(sock, {
        action: 'read',
        channel,
        clientId,
        wait: true
      }, 0)

      sock.destroy()
      abort.socket = null

      if (abort.aborted) break

      if (resp.ok && resp.messages && resp.messages.length > 0) {
        for (const msg of resp.messages) {
          onMessage(msg)
        }
      }
    } catch (e) {
      if (abort.aborted) break

      // Wait and retry on error (daemon may have restarted)
      await new Promise(r => setTimeout(r, 2000))

      if (abort.aborted) break

      try {
        await ensureDaemon()
        // Re-join channel after daemon restart
        const cmd = { action: 'join', channel, secret, clientId }
        if (persist) cmd.persist = true
        await request(cmd)
      } catch {}
    }
  }
}

module.exports = { request, connect, sendCommand, ensureDaemon, streamMessages }
