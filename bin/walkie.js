#!/usr/bin/env node

const { program } = require('commander')
const { request, streamMessages } = require('../src/client')

program
  .name('walkie')
  .description('P2P communication CLI for AI agents')
  .version('1.4.0')

function clientId() {
  if (process.env.WALKIE_ID) return process.env.WALKIE_ID

  // Auto-derive from terminal session (unique per tab/window, stable across commands)
  const sessionHint = process.env.TERM_SESSION_ID   // macOS Terminal.app
    || process.env.ITERM_SESSION_ID                  // iTerm2
    || process.env.WEZTERM_PANE                      // WezTerm
    || process.env.TMUX_PANE                         // tmux
    || process.env.WINDOWID                          // X11 terminals
  if (sessionHint) {
    return require('crypto').createHash('sha256').update(sessionHint).digest('hex').slice(0, 8)
  }

  return undefined // falls back to 'default' in daemon
}

function parseChannelArg(str) {
  const idx = str.indexOf(':')
  if (idx === -1) return { channel: str, secret: str }
  return { channel: str.slice(0, idx), secret: str.slice(idx + 1) }
}

async function autoJoin(channelArg, cid, persist) {
  const { channel, secret } = parseChannelArg(channelArg)
  if (channelArg.indexOf(':') !== -1) {
    const cmd = { action: 'join', channel, secret, clientId: cid }
    if (persist) cmd.persist = true
    await request(cmd)
  }
  return channel
}

function execForMessage(command, msg, channel) {
  const { execSync } = require('child_process')
  try {
    execSync(command, {
      timeout: 30000,
      stdio: 'inherit',
      env: {
        ...process.env,
        WALKIE_MSG: msg.data,
        WALKIE_FROM: msg.from,
        WALKIE_TS: String(msg.ts),
        WALKIE_CHANNEL: channel
      }
    })
  } catch (e) {
    console.error(`exec error: ${e.message}`)
  }
}

program
  .command('connect <channel>')
  .description('Connect to a channel (format: channel:secret)')
  .option('--persist', 'Enable persistent message storage')
  .action(async (channelArg, opts) => {
    try {
      const { channel, secret } = parseChannelArg(channelArg)
      const cmd = { action: 'join', channel, secret, clientId: clientId() }
      if (opts.persist) cmd.persist = true
      const resp = await request(cmd)
      if (resp.ok) {
        console.log(`Connected to channel "${channel}"${opts.persist ? ' [persist]' : ''}`)
      } else {
        console.error(`Error: ${resp.error}`)
        process.exit(1)
      }
    } catch (e) {
      console.error(`Error: ${e.message}`)
      process.exit(1)
    }
  })

program
  .command('watch <channel>')
  .description('Stream messages from a channel (format: channel:secret)')
  .option('--pretty', 'Human-readable format instead of JSONL')
  .option('--exec <cmd>', 'Run command for each message (env: WALKIE_MSG, WALKIE_FROM, WALKIE_TS, WALKIE_CHANNEL)')
  .option('--persist', 'Enable persistent message storage')
  .action(async (channelArg, opts) => {
    try {
      const { channel, secret } = parseChannelArg(channelArg)
      const cid = clientId()
      const joinCmd = { action: 'join', channel, secret, clientId: cid }
      if (opts.persist) joinCmd.persist = true
      const resp = await request(joinCmd)
      if (!resp.ok) {
        console.error(`Error: ${resp.error}`)
        process.exit(1)
      }

      const abort = { aborted: false, socket: null }

      const cleanup = () => {
        abort.aborted = true
        if (abort.socket) {
          try { abort.socket.destroy() } catch {}
        }
        process.exit(0)
      }

      process.on('SIGINT', cleanup)
      process.on('SIGTERM', cleanup)

      await streamMessages(channel, secret, cid, abort, (msg) => {
        if (opts.exec) {
          execForMessage(opts.exec, msg, channel)
        } else if (opts.pretty) {
          const time = new Date(msg.ts).toLocaleTimeString()
          console.log(`[${time}] ${msg.from}: ${msg.data}`)
        } else {
          console.log(JSON.stringify(msg))
        }
      }, opts.persist)
    } catch (e) {
      console.error(`Error: ${e.message}`)
      process.exit(1)
    }
  })

program
  .command('create <channel>')
  .description('Create a channel and wait for peers')
  .requiredOption('-s, --secret <secret>', 'Shared secret')
  .option('--persist', 'Enable persistent message storage')
  .action(async (channel, opts) => {
    console.error('Note: "create" is deprecated, use "walkie connect <channel:secret>"')
    try {
      const cmd = { action: 'join', channel, secret: opts.secret, clientId: clientId() }
      if (opts.persist) cmd.persist = true
      const resp = await request(cmd)
      if (resp.ok) {
        console.log(`Channel "${channel}" created. Listening for peers...`)
      } else {
        console.error(`Error: ${resp.error}`)
        process.exit(1)
      }
    } catch (e) {
      console.error(`Error: ${e.message}`)
      process.exit(1)
    }
  })

program
  .command('join <channel>')
  .description('Join an existing channel')
  .requiredOption('-s, --secret <secret>', 'Shared secret')
  .option('--persist', 'Enable persistent message storage')
  .action(async (channel, opts) => {
    console.error('Note: "join" is deprecated, use "walkie connect <channel:secret>"')
    try {
      const cmd = { action: 'join', channel, secret: opts.secret, clientId: clientId() }
      if (opts.persist) cmd.persist = true
      const resp = await request(cmd)
      if (resp.ok) {
        console.log(`Joined channel "${channel}"`)
      } else {
        console.error(`Error: ${resp.error}`)
        process.exit(1)
      }
    } catch (e) {
      console.error(`Error: ${e.message}`)
      process.exit(1)
    }
  })

program
  .command('send <channel> [message]')
  .description('Send a message to a channel (reads from stdin if no message given)')
  .action(async (channelArg, message) => {
    try {
      // Read from stdin if no message argument provided
      if (!message) {
        const chunks = []
        for await (const chunk of process.stdin) chunks.push(chunk)
        message = Buffer.concat(chunks).toString().trimEnd()
        if (!message) {
          console.error('Error: no message provided')
          process.exit(1)
        }
      }
      // Unescape shell artifacts (e.g. \! from zsh/bash history expansion)
      message = message.replace(/\\!/g, '!')

      const cid = clientId()
      const channel = await autoJoin(channelArg, cid)
      const resp = await request({ action: 'send', channel, message, clientId: cid })
      if (resp.ok) {
        console.log(`Sent (delivered to ${resp.delivered} recipient${resp.delivered !== 1 ? 's' : ''})`)
      } else {
        console.error(`Error: ${resp.error}`)
        process.exit(1)
      }
    } catch (e) {
      console.error(`Error: ${e.message}`)
      process.exit(1)
    }
  })

program
  .command('read <channel>')
  .description('Read pending messages from a channel')
  .option('-w, --wait', 'Block until a message arrives')
  .option('-t, --timeout <seconds>', 'Optional timeout for --wait in seconds')
  .action(async (channelArg, opts) => {
    try {
      const cid = clientId()
      const channel = await autoJoin(channelArg, cid)
      const cmd = { action: 'read', channel, clientId: cid }
      if (opts.wait) {
        cmd.wait = true
        if (opts.timeout) cmd.timeout = parseInt(opts.timeout, 10)
      }
      const timeout = opts.wait
        ? (opts.timeout ? (parseInt(opts.timeout, 10) + 5) * 1000 : 0)  // 0 = no timeout
        : 10000
      const resp = await request(cmd, timeout)
      if (resp.ok) {
        if (resp.messages.length === 0) {
          console.log('No new messages')
        } else {
          for (const msg of resp.messages) {
            const time = new Date(msg.ts).toLocaleTimeString()
            console.log(`[${time}] ${msg.from}: ${msg.data}`)
          }
        }
      } else {
        console.error(`Error: ${resp.error}`)
        process.exit(1)
      }
    } catch (e) {
      console.error(`Error: ${e.message}`)
      process.exit(1)
    }
  })

program
  .command('leave <channel>')
  .description('Leave a channel')
  .action(async (channel) => {
    try {
      const resp = await request({ action: 'leave', channel, clientId: clientId() })
      if (resp.ok) {
        console.log(`Left channel "${channel}"`)
      } else {
        console.error(`Error: ${resp.error}`)
        process.exit(1)
      }
    } catch (e) {
      console.error(`Error: ${e.message}`)
      process.exit(1)
    }
  })

program
  .command('status')
  .description('Show active channels and peers')
  .action(async () => {
    try {
      const resp = await request({ action: 'status' })
      if (resp.ok) {
        console.log(`Daemon ID: ${resp.daemonId}`)
        const entries = Object.entries(resp.channels)
        if (entries.length === 0) {
          console.log('No active channels')
        } else {
          for (const [name, info] of entries) {
            let line = `  #${name} — ${info.peers} peer(s), ${info.subscribers} subscriber(s), ${info.buffered} buffered`
            if (info.persist) line += ` [persist: ${info.stored} stored]`
            console.log(line)
          }
        }
      } else {
        console.error(`Error: ${resp.error}`)
        process.exit(1)
      }
    } catch (e) {
      console.error(`Error: ${e.message}`)
      process.exit(1)
    }
  })

program
  .command('web')
  .description('Start web-based chat UI')
  .option('-p, --port <port>', 'HTTP port', '3000')
  .option('-c, --channel <channels...>', 'Auto-join channels (format: channel:secret)')
  .option('--no-open', 'Do not open browser automatically')
  .action(async (opts) => {
    try {
      const { startWebServer } = require('../src/web')
      const { port } = await startWebServer({ port: parseInt(opts.port, 10) })
      let url = `http://localhost:${port}`
      if (opts.channel && opts.channel.length > 0) {
        url += '?' + opts.channel.map(c => 'c=' + encodeURIComponent(c)).join('&')
      }
      console.log(`walkie web UI → ${url}`)
      if (opts.open) {
        const { exec } = require('child_process')
        const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open'
        exec(`${cmd} ${url}`)
      }
    } catch (e) {
      console.error(`Error: ${e.message}`)
      process.exit(1)
    }
  })

program
  .command('stop')
  .description('Stop the walkie daemon')
  .action(async () => {
    try {
      await request({ action: 'stop' })
      console.log('Daemon stopped')
    } catch {
      console.log('Daemon is not running')
    }
  })

program.parse()
