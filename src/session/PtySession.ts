import chalk from 'chalk'
import pty from 'node-pty'

export interface PtySessionOptions {
  cmd: string
  args: string[]
  env: Record<string, string | undefined>
  onExit?: () => void
}

export class PtySession {
  private term: pty.IPty
  private onResize: () => void
  private sigintCount = 0
  private sigintTimer: ReturnType<typeof setTimeout> | null = null
  private _onChildExit?: () => void

  constructor(options: PtySessionOptions) {
    const cols = process.stdout.columns || 120
    const rows = process.stdout.rows || 30

    this.term = pty.spawn(options.cmd, options.args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: process.cwd(),
      env: options.env,
    })

    this._onChildExit = options.onExit

    this.onResize = () => {
      try {
        this.term.resize(process.stdout.columns || 120, process.stdout.rows || 30)
      } catch { /* swallowed */ }
    }
    process.stdout.on('resize', this.onResize)

    this.setupStdinForwarding()

    this.term.onData((data: string) => {
      process.stdout.write(data)
    })

    this.term.onExit(() => {
      this.cleanup()
    })
  }

  onData(handler: (data: string) => void): void {
    this.term.onData(handler)
  }

  onExit(handler: () => void): void {
    this._onChildExit = handler
  }

  kill(): void {
    this.term.kill()
  }

  private setupStdinForwarding(): void {
    if (!process.stdin.isTTY) return

    process.stdin.setRawMode(true)
    process.stdin.on('data', (data: Buffer) => {
      const input = data.toString()

      if (input === '\x03' && this.sigintCount > 0) {
        console.error(chalk.dim('\nForce terminating...\n'))
        this.term.kill()
        return
      }
      if (input === '\x03') {
        this.sigintCount++
        console.error(chalk.dim('\nShutting down agent... (press Ctrl+C again to force)\n'))
        this.sigintTimer = setTimeout(() => { this.sigintCount = 0 }, 2000)
        return
      }
      this.sigintCount = 0
      this.term.write(input)
    })
    process.stdin.resume()
  }

  private cleanup(): void {
    process.stdout.removeListener('resize', this.onResize)
    if (process.stdin.isTTY && process.stdin.setRawMode) {
      try { process.stdin.setRawMode(false) } catch { /* swallowed */ }
      process.stdin.removeAllListeners('data')
      process.stdin.pause()
    }
    if (this.sigintTimer) clearTimeout(this.sigintTimer)
    this._onChildExit?.()
  }
}
