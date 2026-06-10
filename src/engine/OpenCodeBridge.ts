import { spawn, execSync } from 'child_process'
import { existsSync } from 'fs'
import http from 'http'
import path from 'path'
import type { SessionStore } from './SessionStore.js'
import type { TaskTracker } from './TaskTracker.js'
import type { ContextBuilder } from './ContextBuilder.js'
import { debug } from '../utils/logger.js'

const DEFAULT_PORT = 4096
const CONNECT_TIMEOUT_MS = 15000
const RETRY_INTERVAL_MS = 1000

export interface OpenCodeBridgeOptions {
  port?: number
  store: SessionStore
  tracker: TaskTracker
  contextBuilder: ContextBuilder
  onFileTouch?: (filePath: string) => void
  onTodoUpdate?: (todos: OpenCodeTodo[]) => void
  onSessionIdle?: () => void
  onSessionCreated?: (sessionId: string) => void
}

export interface OpenCodeTodo {
  id: string
  content: string
  status: 'pending' | 'in_progress' | 'completed'
  priority: 'low' | 'medium' | 'high'
}

export class OpenCodeBridge {
  private port: number
  private store: SessionStore
  private tracker: TaskTracker
  private contextBuilder: ContextBuilder
  private opts: OpenCodeBridgeOptions
  private serverProcess: ReturnType<typeof spawn> | null = null
  private sseRequest: http.ClientRequest | null = null
  private running = false
  private openCodeSessionId: string | null = null
  private lastTodos: OpenCodeTodo[] = []

  constructor(opts: OpenCodeBridgeOptions) {
    this.port = opts.port ?? DEFAULT_PORT
    this.store = opts.store
    this.tracker = opts.tracker
    this.contextBuilder = opts.contextBuilder
    this.opts = opts
  }

  // ─── Server management ────────────────────────────────────────────────────

  async startServer(): Promise<boolean> {
    // Check if already running
    if (await this.isServerHealthy()) {
      debug('OpenCode server already running on port', this.port)
      return true
    }

    console.log(`Starting OpenCode server on port ${this.port}...`)

    const agentExe = resolveOpenCodeExe()
    if (!agentExe) {
      console.error('opencode not found. Install it with: npm install -g opencode-ai')
      return false
    }

    this.serverProcess = spawn(agentExe, ['serve', '--port', String(this.port)], {
      cwd: this.store.rootDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
      env: { ...process.env },
      shell: process.platform === 'win32',
    })

    this.serverProcess.stdout?.on('data', (d: Buffer) => debug('opencode-serve:', d.toString().trim()))
    this.serverProcess.stderr?.on('data', (d: Buffer) => debug('opencode-serve err:', d.toString().trim()))

    this.serverProcess.on('exit', (code) => {
      debug('opencode serve exited with code', code)
      this.serverProcess = null
    })

    // Wait for server to be healthy
    const ready = await this.waitForServer()
    if (ready) {
      console.log(`✓ OpenCode server ready on http://localhost:${this.port}`)
    }
    return ready
  }

  stopServer(): void {
    this.stopSSE()
    if (this.serverProcess) {
      this.serverProcess.kill()
      this.serverProcess = null
    }
  }

  private async waitForServer(): Promise<boolean> {
    const deadline = Date.now() + CONNECT_TIMEOUT_MS
    while (Date.now() < deadline) {
      if (await this.isServerHealthy()) return true
      await sleep(RETRY_INTERVAL_MS)
    }
    return false
  }

  async isServerHealthy(): Promise<boolean> {
    return new Promise((resolve) => {
      const req = http.get(`http://localhost:${this.port}/global/health`, (res) => {
        resolve(res.statusCode === 200)
        res.resume()
      })
      req.on('error', () => resolve(false))
      req.setTimeout(2000, () => { req.destroy(); resolve(false) })
    })
  }

  // ─── SSE event stream ─────────────────────────────────────────────────────

  startSSE(): void {
    if (this.running) return
    this.running = true
    this.connectSSE()
  }

  stopSSE(): void {
    this.running = false
    if (this.sseRequest) {
      this.sseRequest.destroy()
      this.sseRequest = null
    }
  }

  private connectSSE(): void {
    if (!this.running) return

    debug('Connecting to SSE event stream...')

    const req = http.get(`http://localhost:${this.port}/event`, {
      headers: { Accept: 'text/event-stream', 'Cache-Control': 'no-cache' },
    }, (res) => {
      if (res.statusCode !== 200) {
        console.error(`[throughline] SSE connection failed (HTTP ${res.statusCode}) — check that opencode serve is running on port ${this.port}`)
        res.resume()
        setTimeout(() => this.connectSSE(), RETRY_INTERVAL_MS * 3)
        return
      }

      console.error('[throughline] SSE event stream connected')
      let buffer = ''

      res.on('data', (chunk: Buffer) => {
        buffer += chunk.toString()
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            this.handleEvent(line.slice(6).trim())
          }
        }
      })

      res.on('end', () => {
        debug('SSE stream ended, reconnecting...')
        if (this.running) setTimeout(() => this.connectSSE(), RETRY_INTERVAL_MS)
      })

      res.on('error', (err) => {
        debug('SSE stream error:', err.message)
        if (this.running) setTimeout(() => this.connectSSE(), RETRY_INTERVAL_MS * 3)
      })
    })

    req.on('error', (err) => {
      debug('SSE request error:', err.message)
      if (this.running) setTimeout(() => this.connectSSE(), RETRY_INTERVAL_MS * 3)
    })

    this.sseRequest = req
  }

  private handleEvent(data: string): void {
    if (!data || data === '') return

    let event: { type: string; properties?: Record<string, unknown> }
    try {
      event = JSON.parse(data)
    } catch {
      return
    }

    debug('SSE event:', event.type)

    switch (event.type) {

      // ── Session created ──────────────────────────────────────────────────
      // ── Session created ──────────────────────────────────────────────────
      // Fired when the user starts a new OpenCode session (via `opencode run`
      // or `opencode attach`). We capture the session ID so we can sync todos
      // and correlate events.
      case 'session.created': {
        const props = event.properties as { id?: string; sessionID?: string } | undefined
        const sid = props?.sessionID || props?.id
        if (sid) {
          this.openCodeSessionId = sid
          debug('OpenCode session created:', sid)
          this.opts.onSessionCreated?.(sid)
        } else {
          debug('session.created with no ID — event:', JSON.stringify(props))
        }
        break
      }

      // ── Session idle = agent finished responding ──────────────────────────
      // The agent has completed its response. We flush context.txt to reflect
      // any task/step state changes, and sync the todo list.
      case 'session.idle': {
        debug('Agent idle — syncing context')
        this.contextBuilder.writeContextFile('session-idle')
        this.opts.onSessionIdle?.()

        if (this.openCodeSessionId) {
          this.syncTodos(this.openCodeSessionId)
        }
        break
      }

      // ── Session.status — alternative idle signal ──────────────────────────
      // OpenCode sends both `session.idle` and `session.status({type:"idle"})`.
      // We handle both to avoid missing idle events.
      case 'session.status': {
        const statusProps = event.properties as { sessionID?: string; status?: { type?: string } } | undefined
        if (statusProps?.status?.type === 'idle') {
          debug('Session idle (via session.status)')
          this.contextBuilder.writeContextFile('session-idle')
          this.opts.onSessionIdle?.()
          if (this.openCodeSessionId || statusProps.sessionID) {
            this.syncTodos(statusProps.sessionID || this.openCodeSessionId!)
          }
        }
        break
      }

      // ── Message part updated — primary event channel ──────────────────────
      // OpenCode SSE sends `message.part.updated` for all agent output:
      //   text parts  → carry Throughline markers (PLAN, STEP_DONE, NOTE, etc.)
      //   tool parts  → carry tool execution events (write, read, bash, etc.)
      // Each tool event goes through 3 phases: pending → running → completed.
      // We capture file writes at the "completed" phase to avoid recording
      // writes that later fail.
      case 'message.part.updated':
      case 'message.part.delta': {
        const props = event.properties as {
          sessionID?: string
          part?: {
            type?: string
            text?: string
            tool?: string
            callID?: string
            state?: {
              status?: string
              input?: Record<string, unknown>
              metadata?: { output?: string }
            }
          }
          time?: number
        } | undefined

        if (!props?.part) break

        if (props.part.type === 'text' && props.part.text) {
          this.maybeParseMarkers(props.part.text)
        } else if (props.part.type === 'tool' && props.part.tool) {
          this.handleToolEvent(props.part.tool.toLowerCase(), props.part.state?.input ?? {}, props.part.state?.status)
        }
        break
      }

      default: {
        debug('Unhandled event type:', event.type)
        break
      }
    }
  }

  // ─── Todo sync ────────────────────────────────────────────────────────────

  private async syncTodos(sessionId: string): Promise<void> {
    return new Promise((resolve) => {
      http.get(`http://localhost:${this.port}/session/${sessionId}/todo`, (res) => {
        let body = ''
        res.on('data', (d: Buffer) => body += d.toString())
        res.on('end', () => {
          try {
            const todos = JSON.parse(body) as OpenCodeTodo[]
            this.syncTodosFromPayload(todos)
          } catch (err) {
            debug('Failed to parse todos:', err)
          }
          resolve()
        })
      }).on('error', () => resolve())
    })
  }

  private syncTodosFromPayload(todos: OpenCodeTodo[]): void {
    if (!todos || todos.length === 0) return
    this.lastTodos = todos
    this.opts.onTodoUpdate?.(todos)

    if (!this.store.hasActiveSession()) return
    const graph = this.store.read()

    // If tasks already exist (from a PLAN marker), update their statuses
    if (graph.tasks.length > 0) {
      let changed = false
      for (const todo of todos) {
        const task = graph.tasks.find(t => t.intent === todo.content)
        if (task && task.status !== this.mapTodoStatus(todo.status)) {
          task.status = this.mapTodoStatus(todo.status)
          changed = true
        }
      }
      if (changed) {
        this.store.write(graph)
        this.contextBuilder.writeContextFile('todo-update')
      }
      return
    }

    // Convert todo list to Throughline tasks
    const tasks = todos.map(t => ({
      intent: t.content,
      declared_by: 'ai' as const,
      status: this.mapTodoStatus(t.status),
      depends_on: [] as string[],
      steps: [] as Array<{
        id: string
        intent: string
        declared_by: 'ai'
        status: 'pending'
        files: { planned: string[]; touched: string[] }
        deviation: null
        completed_at: null
      }>,
    }))

    this.tracker.addTasks(tasks)
    this.contextBuilder.writeContextFile('todo-sync')
    console.error(`\n✓ Synced ${todos.length} tasks from OpenCode todo list`)
  }

  private mapTodoStatus(status: string): 'pending' | 'in_progress' | 'complete' | 'abandoned' | 'deviated' {
    switch (status) {
      case 'completed': return 'complete'
      case 'in_progress': return 'in_progress'
      default: return 'pending'
    }
  }

  // ─── Marker parsing (opportunistic) ──────────────────────────────────────

  private maybeParseMarkers(text: string): void {
    // Still parse markers if present — they're a bonus not a requirement

    // PLAN — create tasks with full steps from the plan
    const planMatch = text.match(/\[THROUGHLINE:PLAN\]([\s\S]*?)\[\/THROUGHLINE:PLAN\]/)
    if (planMatch) {
      void this.handlePlanMarker(planMatch[1])
    }

    const deviateMatch = text.match(/\[THROUGHLINE:DEVIATE\s+reason="([^"]+)"(?:\s+spawns="([^"]+)")?\]/)
    if (deviateMatch) {
      const currentTask = this.tracker.getCurrentTask()
      const currentStep = this.tracker.getCurrentStep()
      if (currentTask && currentStep) {
        this.tracker.recordDeviation(currentTask.id, currentStep.id, {
          reason: deviateMatch[1],
          spawned_task: deviateMatch[2] || null,
          recorded_at: new Date().toISOString(),
        })
        this.contextBuilder.writeContextFile('deviation')
        console.error(`\n⚡ Deviation: ${deviateMatch[1]}`)
      }
    }

    const noteMatch = text.match(/\[THROUGHLINE:NOTE\s+text="([^"]+)"(?:\s+category="([^"]+)")?\]/)
    if (noteMatch) {
      this.store.addNote(noteMatch[1], 'ai', noteMatch[2])
      this.contextBuilder.writeContextFile('note')
      console.error(`\n📝 Note: ${noteMatch[1]}`)
    }

    // STEP_DONE — advance throughline step
    if (/\[THROUGHLINE:STEP_DONE\]/.test(text)) {
      const currentTask = this.tracker.getCurrentTask()
      const currentStep = this.tracker.getCurrentStep()
      if (currentTask && currentStep) {
        this.tracker.completeStep(currentTask.id, currentStep.id)
        this.contextBuilder.writeContextFile('step-done')

        const graph = this.store.read()
        const task = graph.tasks.find(t => t.id === currentTask.id)!
        const nextStep = task.steps.find(s => s.status === 'pending')
        if (nextStep) {
          this.tracker.setStepStatus(task.id, nextStep.id, 'in_progress')
          this.contextBuilder.writeContextFile('step-advance')
          console.error(`\n▶ Step: ${nextStep.intent}`)
        }
      }
    }
  }

  private handlePlanMarker(jsonStr: string): void {
    if (!this.store.hasActiveSession()) return

    let planData: { tasks: Array<{ intent: string; steps: Array<{ intent: string; files: string[] }> }> }
    try {
      planData = JSON.parse(jsonStr)
    } catch (err) {
      console.error(`[throughline] Failed to parse PLAN marker: ${(err as Error).message}`)
      return
    }

    if (!planData?.tasks?.length) return

    const graph = this.store.read()

    if (graph.tasks.length === 0) {
      // No tasks yet — create them from the plan with full step definitions
      const tasks = planData.tasks.map((t: { intent: string; steps: Array<{ intent: string; files: string[] }> }) => ({
        intent: t.intent,
        declared_by: 'ai' as const,
        status: 'pending' as const,
        depends_on: [] as string[],
        steps: t.steps.map((s: { intent: string; files: string[] }) => ({
          id: '',
          intent: s.intent,
          declared_by: 'ai' as const,
          status: 'pending' as const,
          files: { planned: s.files ?? [], touched: [] as string[] },
          deviation: null,
          completed_at: null,
        })),
      }))

      this.tracker.addTasks(tasks)
      this.contextBuilder.writeContextFile('plan')

      const stepCount = tasks.reduce((a: number, t: { steps: Array<unknown> }) => a + t.steps.length, 0)
      console.error(`\n✓ Intent plan captured (${tasks.length} tasks, ${stepCount} steps)`)

      // Auto-start first step
      const updated = this.store.read()
      const t0 = updated.tasks[0]
      if (t0 && t0.steps[0]) {
        this.tracker.setStepStatus(t0.id, t0.steps[0].id, 'in_progress')
        this.contextBuilder.writeContextFile('step-advance')
        console.error(`\n▶ Step: ${t0.steps[0].intent}`)
      }
    } else {
      // Tasks already exist (from todo-sync) — merge steps from plan into matching tasks
      let merged = false
      for (const planTask of planData.tasks) {
        const existing = graph.tasks.find(t => t.intent === planTask.intent)
        if (existing && existing.steps.length === 0 && planTask.steps.length > 0) {
          existing.steps = planTask.steps.map((s, j) => ({
            id: `${existing.id}-s${j + 1}`,
            intent: s.intent,
            declared_by: 'ai' as const,
            status: j === 0 ? 'in_progress' as const : 'pending' as const,
            files: { planned: s.files ?? [], touched: [] as string[] },
            deviation: null,
            completed_at: null,
          }))
          existing.status = 'in_progress'
          merged = true
        }
      }
      if (merged) {
        this.store.write(graph)
        this.contextBuilder.writeContextFile('plan-merge')
        console.error(`\n✓ Steps merged from PLAN into existing tasks`)
      }
    }
  }

  // ─── Tool event handler ──────────────────────────────────────────────────
  // Receives tool execution events from `message.part.updated`.
  // Tool names are normalized lowercase (e.g. "write", "bash", "todowrite").
  // Each tool goes through phases (pending→running→completed); we gate file
  // recording on "completed" to avoid tracking writes that later abort.

  private handleToolEvent(toolName: string, input: Record<string, unknown>, status?: string): void {
    const isWriteTool = ['write', 'file.write', 'createfile', 'create_file', 'filewrite', 'edit', 'file.edit', 'editfile', 'edit_file'].includes(toolName)
    const isReadTool = ['read', 'file.read', 'readfile', 'read_file', 'fileread'].includes(toolName)
    const isBashTool = ['bash', 'shell', 'run', 'command', 'execute'].includes(toolName)
    const isTodoTool = ['todowrite', 'todo.write', 'todos', 'task.write'].includes(toolName)

    if (isWriteTool || isReadTool) {
      const filePath = (
        input.filePath ??
        input.path ??
        input.file_path ??
        input.file ??
        input.filename ??
        ''
      ) as string | undefined

      if (filePath) {
        const relative = toRelative(filePath, this.store.rootDir)
        if (isWriteTool) {
          if (status === 'completed') {
            this.tracker.recordFileTouched(relative)
            this.contextBuilder.writeContextFile('file-touch')
            this.opts.onFileTouch?.(relative)
            console.error(`[throughline] File written: ${relative}`)
          }
        } else {
          this.tracker.recordFileTouched(relative)
        }
      } else if (isWriteTool) {
        console.error(`[throughline] Write tool event with no filePath — input keys: ${Object.keys(input).join(', ')}`)
      }
    } else if (isBashTool) {
      const cmd = (input.command ?? input.cmd ?? input.script ?? '') as string | undefined
      if (!cmd) return
      if (/git\s+(add|commit)/.test(cmd)) {
        this.contextBuilder.writeContextFile('git-op')
      }
    } else if (isTodoTool) {
      const todos = (
        input.todos ??
        input.tasks ??
        input.items ??
        []
      ) as OpenCodeTodo[] | undefined
      if (todos && Array.isArray(todos) && todos.length > 0) {
        this.syncTodosFromPayload(todos)
      }
    // MCP tool events — throughline_get_context and throughline_status are
    // read-only queries from the agent; skill events load skill instructions.
    // No state change needed — we just log the read for audit purposes.
    } else if (toolName.startsWith('throughline_') || toolName === 'skill') {
      debug(`MCP tool: ${toolName}`)
      if (toolName === 'throughline_throughline_get_context' || toolName === 'throughline_status') {
        this.contextBuilder.logContextRead('mcp-tool')
      }
    } else if (toolName) {
      console.error(`[throughline] Unhandled tool event: "${toolName}" — input keys: ${Object.keys(input).join(', ')}`)
    }
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  getLastTodos(): OpenCodeTodo[] {
    return this.lastTodos
  }

  getOpenCodeSessionId(): string | null {
    return this.openCodeSessionId
  }

  getPort(): number {
    return this.port
  }
}

// ─── Module helpers ───────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

function toRelative(filePath: string, rootDir: string): string {
  const normalized = path.normalize(filePath)
  const normalizedRoot = path.normalize(rootDir)
  if (normalized.startsWith(normalizedRoot)) {
    return normalized.slice(normalizedRoot.length).replace(/^[/\\]/, '')
  }
  return filePath
}

export function resolveOpenCodeExe(): string | null {
  const which = process.platform === 'win32' ? 'where' : 'which'
  try {
    const result = execSync(`${which} opencode`, { encoding: 'utf8', stdio: 'pipe' }).trim()
    const paths = result.split('\n').map(s => s.trim()).filter(Boolean)
    if (process.platform === 'win32') {
      const cmdPath = paths.find(p => /\.cmd$/i.test(p))
      if (cmdPath && existsSync(cmdPath)) return cmdPath
      const exePath = paths.find(p => /\.exe$/i.test(p))
      if (exePath && existsSync(exePath)) return exePath
    }
    return paths[0] || null
  } catch {
    return null
  }
}
