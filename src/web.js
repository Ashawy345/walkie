const http = require('http')
const crypto = require('crypto')
const WebSocket = require('ws')
const { request, connect, sendCommand, ensureDaemon } = require('./client')
const HTML = require('./web-ui')

class WebClient {
  constructor(ws) {
    this.ws = ws
    this.clientId = 'web-' + crypto.randomBytes(4).toString('hex')
    this.channels = new Map() // channel -> { secret, abort: { aborted, socket } }
    this.send({ type: 'hello', clientId: this.clientId })
  }

  send(data) {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data))
    }
  }

  async handleMessage(raw) {
    let msg
    try { msg = JSON.parse(raw) } catch { return }

    try {
      switch (msg.type) {
        case 'join':
          await this.join(msg.channel, msg.secret, msg.persist)
          break
        case 'send':
          await this.sendMsg(msg.channel, msg.message)
          break
        case 'leave':
          await this.leave(msg.channel)
          break
        case 'rename':
          await this.rename(msg.name)
          break
        case 'status':
          await this.status()
          break
      }
    } catch (e) {
      this.send({ type: 'error', error: e.message })
    }
  }

  async join(channel, secret, persist) {
    if (this.channels.has(channel)) return

    const cmd = {
      action: 'join',
      channel,
      secret,
      clientId: this.clientId
    }
    if (persist) cmd.persist = true
    const resp = await request(cmd)

    if (!resp.ok) {
      this.send({ type: 'error', error: resp.error })
      return
    }

    const abort = { aborted: false, socket: null }
    this.channels.set(channel, { secret, persist, abort })
    this.send({ type: 'joined', channel })

    // Drain any buffered messages
    try {
      const drain = await request({
        action: 'read',
        channel,
        clientId: this.clientId
      })
      if (drain.ok && drain.messages.length > 0) {
        this.send({ type: 'messages', channel, messages: drain.messages })
      }
    } catch {}

    // Start blocking read loop
    this._readLoop(channel, abort)
  }

  async sendMsg(channel, message) {
    const resp = await request({
      action: 'send',
      channel,
      message,
      clientId: this.clientId
    })

    if (resp.ok) {
      this.send({ type: 'sent', channel, delivered: resp.delivered })
    } else {
      this.send({ type: 'error', error: resp.error })
    }
  }

  async leave(channel) {
    const entry = this.channels.get(channel)
    if (!entry) return

    entry.abort.aborted = true
    if (entry.abort.socket) {
      try { entry.abort.socket.destroy() } catch {}
    }
    this.channels.delete(channel)

    try {
      await request({
        action: 'leave',
        channel,
        clientId: this.clientId
      })
    } catch {}

    this.send({ type: 'left', channel })
  }

  async rename(name) {
    name = (name || '').trim().replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32)
    if (!name) return

    const oldId = this.clientId
    const entries = [...this.channels.entries()]

    // Leave all channels with old clientId, abort read loops
    for (const [channel, entry] of entries) {
      entry.abort.aborted = true
      if (entry.abort.socket) {
        try { entry.abort.socket.destroy() } catch {}
      }
      try {
        await request({ action: 'leave', channel, clientId: oldId })
      } catch {}
    }
    this.channels.clear()

    // Update identity
    this.clientId = name
    this.send({ type: 'renamed', clientId: this.clientId })

    // Re-join all channels with new clientId
    for (const [channel, entry] of entries) {
      await this.join(channel, entry.secret, entry.persist)
    }
  }

  async status() {
    const resp = await request({ action: 'status' })
    if (resp.ok) {
      this.send({ type: 'status', channels: resp.channels })
    }
  }

  async cleanup() {
    for (const [channel, entry] of this.channels) {
      entry.abort.aborted = true
      if (entry.abort.socket) {
        try { entry.abort.socket.destroy() } catch {}
      }
      // Fire-and-forget leave
      request({
        action: 'leave',
        channel,
        clientId: this.clientId
      }).catch(() => {})
    }
    this.channels.clear()
  }

  async _readLoop(channel, abort) {
    while (!abort.aborted) {
      try {
        const sock = await connect()
        abort.socket = sock

        const resp = await sendCommand(sock, {
          action: 'read',
          channel,
          clientId: this.clientId,
          wait: true
        }, 0)

        sock.destroy()
        abort.socket = null

        if (abort.aborted) break

        if (resp.ok && resp.messages && resp.messages.length > 0) {
          this.send({ type: 'messages', channel, messages: resp.messages })
        }
      } catch (e) {
        if (abort.aborted) break

        // Wait and retry on error (daemon may have restarted)
        await new Promise(r => setTimeout(r, 2000))

        if (abort.aborted) break

        try {
          await ensureDaemon()
          // Re-join channel after daemon restart
          const entry = this.channels.get(channel)
          if (entry) {
            const cmd = {
              action: 'join',
              channel,
              secret: entry.secret,
              clientId: this.clientId
            }
            if (entry.persist) cmd.persist = true
            await request(cmd)
          }
        } catch {}
      }
    }
  }
}

function tryListen(server, port, maxAttempts = 10) {
  return new Promise((resolve, reject) => {
    let attempts = 0
    const try_ = () => {
      attempts++
      const onError = (err) => {
        server.removeListener('listening', onListen)
        if (err.code === 'EADDRINUSE' && attempts < maxAttempts) {
          port++
          try_()
        } else {
          reject(err)
        }
      }
      const onListen = () => {
        server.removeListener('error', onError)
        resolve(port)
      }
      server.once('error', onError)
      server.once('listening', onListen)
      server.listen(port)
    }
    try_()
  })
}

async function startWebServer({ port = 3000 } = {}) {
  await ensureDaemon()

  const server = http.createServer((req, res) => {
    const pathname = req.url.split('?')[0]
    if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(HTML)
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' })
      res.end('Not found')
    }
  })

  const actualPort = await tryListen(server, port)

  const wss = new WebSocket.Server({ server, path: '/ws' })

  wss.on('connection', (ws) => {
    const client = new WebClient(ws)
    ws.on('message', data => client.handleMessage(data))
    ws.on('close', () => client.cleanup())
  })

  return { port: actualPort, close: () => server.close() }
}

module.exports = { startWebServer }
