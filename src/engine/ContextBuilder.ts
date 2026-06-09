import fs from 'fs'
import path from 'path'
import type { IntentGraph } from '../types.js'
import { SessionStore } from './SessionStore.js'

export class ContextBuilder {
  private store: SessionStore
  private _readWatcherHandle?: ReturnType<typeof setInterval>
  private _lastWriteAt: number = 0

  constructor(store: SessionStore) {
    this.store = store
  }

  get contextFilePath(): string {
    return path.join(this.store.intentDir, 'context.txt')
  }

  get auditLogPath(): string {
    return path.join(this.store.intentDir, 'context-audit.log')
  }

  logContextRead(source: string = 'agent'): void {
    try {
      const entry = `[${new Date().toISOString()}] trigger=context-read source=${source} session=${this.store.hasActiveSession() ? this.store.read().session.id : 'none'}\n`
      fs.appendFileSync(this.auditLogPath, entry, 'utf8')
    } catch { /* swallow */ }
  }

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
      } catch { /* swallow */ }
    }, intervalMs)
  }

  stopReadWatcher(): void {
    if (this._readWatcherHandle) {
      clearInterval(this._readWatcherHandle)
      this._readWatcherHandle = undefined
    }
  }

  writeContextFile(trigger: string, parentGraph?: IntentGraph): void {
    if (!this.store.hasActiveSession() && !this.store.isInitialized()) return
    try {
      const block = this.buildContextBlock(parentGraph)
      fs.writeFileSync(this.contextFilePath, block, 'utf8')
      this._lastWriteAt = Date.now()

      const entry = `[${new Date().toISOString()}] trigger=${trigger} size=${Buffer.byteLength(block)} session=${this.store.hasActiveSession() ? this.store.read().session.id : 'none'}\n`
      fs.appendFileSync(this.auditLogPath, entry, 'utf8')
    } catch {
      fs.writeFileSync(this.contextFilePath, '# Throughline: no active session\n', 'utf8')
    }
  }

  buildContextBlock(parentGraph?: IntentGraph): string {
    const graph = this.store.read()
    const { session, tasks } = graph

    const completedTasks = tasks.filter(t => t.status === 'complete').map(t => `  ✓ ${t.intent}`).join('\n')
    const currentTask = tasks.find(t => t.status === 'in_progress' || t.status === 'deviated')
    const pendingTasks = tasks.filter(t => t.status === 'pending').map(t => `  · ${t.intent}`).join('\n')
    const deviations = tasks.flatMap(t => t.steps.filter(s => s.deviation)).length

    let block = `[THROUGHLINE CONTEXT]\n`
    block += `Session goal: ${session.goal}\n`
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

    if (session.notes.length > 0) {
      block += `\nSession notes:\n`
      session.notes.forEach(n => block += `  · ${n.text}\n`)
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
      }
      if (pendingSteps) block += `  Pending steps:\n${pendingSteps}\n`
    }

    if (pendingTasks) block += `\nPending tasks:\n${pendingTasks}\n`
    if (deviations > 0) block += `\nDeviations recorded: ${deviations}\n`

    block += `[/THROUGHLINE CONTEXT]`
    return block
  }
}
