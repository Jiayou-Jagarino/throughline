// ─── Context builder ────────────────────────────────────────────────────
// Generates and persists the [THROUGHLINE CONTEXT] block (context.txt) that
// agents read to understand session state. Triggers on every event: idle,
// file touch, marker, command. Also monitors external reads via stat atime.
import fs from 'fs'
import path from 'path'
import type { IntentGraph } from '../types.js'
import { SessionStore } from './SessionStore.js'

export class ContextBuilder {
  private store: SessionStore
  private _readWatcherHandle?: ReturnType<typeof setInterval>
  private _lastWriteAt: number = 0
  private _lastIdleTime: number = 0

  constructor(store: SessionStore) {
    this.store = store
  }

  get contextFilePath(): string {
    return path.join(this.store.intentDir, 'context.txt')
  }

  get auditLogPath(): string {
    return path.join(this.store.intentDir, 'context-audit.log')
  }

  // Log whenever context.txt is read — by the agent (via MCP), by the
  // filesystem watcher, or by other tool events. The audit trail helps
  // diagnose whether the agent is seeing stale context.
  logContextRead(source: string = 'agent'): void {
    try {
      const entry = `[${new Date().toISOString()}] trigger=context-read source=${source} session=${this.store.hasActiveSession() ? this.store.read().session.id : 'none'}\n`
      fs.appendFileSync(this.auditLogPath, entry, 'utf8')
    } catch (err) {
      console.error(`[throughline] Failed to log context read: ${(err as Error).message}`)
    }
  }

  // ─── Read watcher (filesystem) ──────────────────────────────────────────
  // Polls context.txt's atime every 5s. If atime advances without mtime
  // changing, an external process (the agent) read the file. Logs to audit.
  startReadWatcher(intervalMs: number = 5000): void {
    if (this._readWatcherHandle) return
    if (!fs.existsSync(this.contextFilePath)) return

    const initial = fs.statSync(this.contextFilePath)
    let prevAtime = initial.atimeMs
    let prevMtime = initial.mtimeMs

    this._readWatcherHandle = setInterval(() => {
      try {
        if (!fs.existsSync(this.contextFilePath)) return
        const curr = fs.statSync(this.contextFilePath)

        // mtime change = a write happened (from any process). Don't count as read.
        // Pure atime advance (mtime unchanged) = external read.
        if (curr.atimeMs > prevAtime && curr.mtimeMs === prevMtime) {
          this.logContextRead('filesystem')
        }

        prevAtime = Math.max(curr.atimeMs, prevAtime)
        prevMtime = Math.max(curr.mtimeMs, prevMtime)
      } catch (err) {
        console.error(`[throughline] Read watcher error: ${(err as Error).message}`)
      }
    }, intervalMs)
  }

  stopReadWatcher(): void {
    if (this._readWatcherHandle) {
      clearInterval(this._readWatcherHandle)
      this._readWatcherHandle = undefined
    }
  }

  // ─── Write context.txt ──────────────────────────────────────────────────
  // Builds the context block from current session state and writes it to
  // .intent/context.txt. The trigger parameter identifies what caused the
  // write and is logged in the audit trail.
  writeContextFile(trigger: string, parentGraph?: IntentGraph): void {
    if (!this.store.hasActiveSession() && !this.store.isInitialized()) return

    // Session-idle dedup: OpenCode fires idle on every response chunk. We
    // skip consecutive idles within 5 seconds to avoid thrashing context.txt.
    if (trigger === 'session-idle') {
      const now = Date.now()
      if (now - this._lastIdleTime < 5000) return
      this._lastIdleTime = now
    }

    try {
      const block = this.buildContextBlock(parentGraph)
      fs.writeFileSync(this.contextFilePath, block, 'utf8')
      this._lastWriteAt = Date.now()

      const entry = `[${new Date().toISOString()}] trigger=${trigger} size=${Buffer.byteLength(block)} session=${this.store.hasActiveSession() ? this.store.read().session.id : 'none'}\n`
      fs.appendFileSync(this.auditLogPath, entry, 'utf8')
    } catch (err) {
      try {
        fs.writeFileSync(this.contextFilePath, '# Throughline: no active session\n', 'utf8')
      } catch (fallbackErr) {
        console.error(`[throughline] Failed to write context file: ${(err as Error).message} (fallback also failed: ${(fallbackErr as Error).message})`)
      }
    }
  }

  // ─── Build the context block ────────────────────────────────────────────
  // Assembles the [THROUGHLINE CONTEXT] string from the current graph:
  // session goal, task tree, current step, deviations, notes. Optionally
  // includes parent session context for resume/repair/continue sessions.
  buildContextBlock(parentGraph?: IntentGraph): string {
    const graph = this.store.read()
    const { session, tasks } = graph

    const completedTasks = tasks.filter(t => t.status === 'complete').map(t => `  ✓ ${t.intent}`).join('\n')
    const currentTask = tasks.find(t => t.status === 'in_progress' || t.status === 'deviated')
    const pendingTasks = tasks.filter(t => t.status === 'pending').map(t => `  · ${t.intent}`).join('\n')
    const deviations = tasks.flatMap(t => t.steps.filter(s => s.deviation)).length
    const decisionNotes = session.notes.filter(n => n.category === 'decision')
    const instructionNotes = session.notes.filter(n => n.category === 'instruction')
    const contextNotes = session.notes.filter(n => n.category === 'context')
    const insightNotes = session.notes.filter(n => n.category === 'insight')

    let block = `[THROUGHLINE CONTEXT]\n`
    block += `Session goal: ${session.goal}\n`
    block += `Session ID: ${session.id}\n`
    block += `Status: ${session.status}\n`

    if (session.relation && session.parent_session) {
      block += `Relation: ${session.relation} of ${session.parent_session}\n`
    }

    if (parentGraph) {
      const parentCompleted = parentGraph.tasks.filter(t => t.status === 'complete').map(t => `  ✓ ${t.intent}`).join('\n')
      const parentDeviations = parentGraph.tasks.flatMap(t => t.steps.filter(s => s.deviation))
      const parentNotes = parentGraph.session.notes.map(n => `  · ${n.text}`).join('\n')

      block += `\nPrevious session (${parentGraph.session.id}): "${parentGraph.session.goal}"\n`
      if (parentCompleted) block += `Completed in previous session:\n${parentCompleted}\n`
      if (parentDeviations.length > 0) {
        block += `Deviations from previous session:\n`
        parentDeviations.forEach(s => block += `  ⚡ ${s.deviation?.reason}\n`)
      }
      if (parentNotes) block += `Notes from previous session:\n${parentNotes}\n`
    }

    // Show decisions prominently — they're the most critical for resumed agents
    if (decisionNotes.length > 0) {
      block += `\nKey decisions:\n`
      decisionNotes.forEach(n => block += `  · ${n.text}\n`)
    }

    if (instructionNotes.length > 0) {
      block += `\nInstructions given (last first):\n`
      instructionNotes.slice(-3).reverse().forEach(n => block += `  → ${n.text}\n`)
    }

    if (contextNotes.length > 0) {
      block += `\nContext:\n`
      contextNotes.slice(-5).forEach(n => block += `  · ${n.text}\n`)
    }

    if (insightNotes.length > 0) {
      block += `\nInsights:\n`
      insightNotes.slice(-5).forEach(n => block += `  · ${n.text}\n`)
    }

    // Unclassified notes
    const uncategorized = session.notes.filter(n => !n.category || !['decision', 'instruction', 'context', 'insight'].includes(n.category))
    if (uncategorized.length > 0) {
      block += `\nNotes:\n`
      uncategorized.forEach(n => block += `  · ${n.text}\n`)
    }

    block += '\n'
    if (completedTasks) block += `Completed tasks:\n${completedTasks}\n\n`

    if (currentTask) {
      block += `Current task: ${currentTask.intent} (${currentTask.id})\n`
      const completedSteps = currentTask.steps.filter(s => s.status === 'complete').map(s => `  ✓ ${s.intent}`).join('\n')
      const currentStep = currentTask.steps.find(s => s.status === 'in_progress')
      const pendingSteps = currentTask.steps.filter(s => s.status === 'pending').map(s => `  · ${s.intent}`).join('\n')

      if (completedSteps) block += `  Completed steps:\n${completedSteps}\n`
      if (currentStep) {
        block += `  Current step: ${currentStep.intent} (${currentStep.id})\n`
        if (currentStep.files.planned.length > 0) {
          block += `  Planned files: ${currentStep.files.planned.join(', ')}\n`
        }
        if (currentStep.files.touched.length > 0) {
          block += `  Files touched: ${currentStep.files.touched.join(', ')}\n`
        }
      }
      if (pendingSteps) block += `  Pending steps:\n${pendingSteps}\n`
    }

    if (pendingTasks) block += `\nPending tasks:\n${pendingTasks}\n`
    if (deviations > 0) block += `\nDeviations recorded: ${deviations}\n`

    block += `\n---\n`
    block += `To update this session, emit Throughline markers in your response:\n`
    block += `[THROUGHLINE:PLAN]{"tasks":[{"intent":"...","steps":[{"intent":"...","files":["..."]}]}]}[/THROUGHLINE:PLAN]\n`
    block += `[THROUGHLINE:STEP_DONE]\n`
    block += `[THROUGHLINE:DEVIATE reason="..." spawns="..."]\n`
    block += `[THROUGHLINE:NOTE text="..." category="decision|context|feedback|insight|instruction"]\n`
    block += `[/THROUGHLINE CONTEXT]`
    return block
  }
}
