// ─── Session persistence ─────────────────────────────────────────────────
// File-backed YAML store for session state. Reads/writes .intent/session.yml
// with file locking and atomic writes. Manages lifecycle: init, create,
// read, write, close. Archives closed sessions to .intent/history/.
import { execSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import yaml from 'js-yaml'
import type { IntentGraph, Agent, SessionRelation } from '../types.js'

const INTENT_DIR = '.intent'
const SESSION_FILE = 'session.yml'
const HISTORY_DIR = 'history'
const LOCK_FILE = '.session.lock'
const LOCK_RETRIES = 30
const LOCK_RETRY_MS = 50

export class SessionStore {
  private root: string

  constructor(cwd: string = process.cwd()) {
    this.root = cwd
  }

  get rootDir() { return this.root }
  get intentDir() { return path.join(this.root, INTENT_DIR) }
  get sessionFile() { return path.join(this.intentDir, SESSION_FILE) }
  get historyDir() { return path.join(this.intentDir, HISTORY_DIR) }

  // ─── Initialize .intent/ directory ──────────────────────────────────────
  // Creates .intent/, copies SPEC.md, sets up .gitignore, and auto-inits
  // git if the project isn't already a repository.
  init(): void {
    if (!fs.existsSync(this.intentDir)) {
      fs.mkdirSync(this.intentDir, { recursive: true })
    }
    if (!fs.existsSync(this.historyDir)) {
      fs.mkdirSync(this.historyDir, { recursive: true })
    }

    const specSrc = path.join(path.dirname(new URL(import.meta.url).pathname), '../../SPEC.md')
    const specDst = path.join(this.intentDir, 'spec.md')
    if (fs.existsSync(specSrc) && !fs.existsSync(specDst)) {
      fs.copyFileSync(specSrc, specDst)
    }

    const gitignore = path.join(this.root, '.gitignore')
    const entry = '.intent/session.yml'
    if (fs.existsSync(gitignore)) {
      const content = fs.readFileSync(gitignore, 'utf8')
      if (!content.includes(entry)) {
        fs.appendFileSync(gitignore, `\n# Throughline active session\n${entry}\n`)
      }
    } else {
      try {
        fs.writeFileSync(gitignore, `# Throughline active session\n${entry}\n`, 'utf8')
      } catch (err) {
        console.error(`[throughline] Failed to create .gitignore: ${(err as Error).message}`)
      }
    }

    // Auto-init git if the directory isn't already a repository
    const gitDir = path.join(this.root, '.git')
    if (!fs.existsSync(gitDir)) {
      try {
        execSync('git init', { cwd: this.root, stdio: 'pipe', timeout: 10000 })
        console.error('[throughline] git init: initialized new repository')
      } catch (err) {
        console.error(`[throughline] git init: skipped (${(err as Error).message})`)
      }
    }
  }

  isInitialized(): boolean {
    return fs.existsSync(this.intentDir)
  }

  hasActiveSession(): boolean {
    return fs.existsSync(this.sessionFile)
  }

  read(): IntentGraph {
    if (!this.hasActiveSession()) {
      throw new Error('No active session. Run `throughline start "your goal"` first.')
    }
    return this._readYamlFile(this.sessionFile)
  }

  write(graph: IntentGraph): void {
    this._acquireLock()
    try {
      this._writeAtomic(this.sessionFile, yaml.dump(graph, { lineWidth: 120 }))
    } finally {
      this._releaseLock()
    }
  }

  // ─── Create a new session ────────────────────────────────────────────────
  // Generates a sequential session ID (session-001, session-002, ...).
  // For resume/repair/continue, derives ID from the ROOT session (not the
  // parent) to avoid recursive stacking (e.g. session-010-resume-resume-2).
  createSession(goal: string, agent: Agent = 'claude-code', parent?: { id: string; relation: SessionRelation }): IntentGraph {
    let id: string
    if (parent) {
      // Walk up to root session to avoid stacking
      let rootId = parent.id
      const visited = new Set<string>()
      while (!visited.has(rootId)) {
        visited.add(rootId)
        const graph = this.getSessionById(rootId)
        if (graph?.session.parent_session) {
          rootId = graph.session.parent_session
        } else {
          break
        }
      }
      id = `${rootId}-${parent.relation}`
      if (this.getSessionById(id)) {
        let counter = 2
        while (this.getSessionById(`${rootId}-${parent.relation}-${counter}`)) counter++
        id = `${rootId}-${parent.relation}-${counter}`
      }
    } else {
      id = this.nextSessionId()
    }
    const graph: IntentGraph = {
      session: {
        id,
        goal,
        declared_by: 'developer',
        status: 'pending',
        started_at: new Date().toISOString(),
        closed_at: null,
        agent,
        parent_session: parent?.id || null,
        relation: parent?.relation || null,
        notes: [],
      },
      tasks: [],
    }
    this.write(graph)
    return graph
  }

  // ─── Close session and archive ───────────────────────────────────────────
  // Sets final status, archives to .intent/history/<id>.yml, removes
  // session.yml, clears context.txt.
  closeSession(status: 'complete' | 'abandoned' = 'complete'): void {
    const graph = this.read()
    graph.session.status = status
    graph.session.closed_at = new Date().toISOString()

    const archivePath = path.join(this.historyDir, `${graph.session.id}.yml`)
    this._acquireLock()
    try {
      this._writeAtomic(archivePath, yaml.dump(graph, { lineWidth: 120 }))
      fs.unlinkSync(this.sessionFile)
      // Clear stale context file so it reflects closed state
      const ctxPath = path.join(this.intentDir, 'context.txt')
      if (fs.existsSync(ctxPath)) {
        fs.writeFileSync(ctxPath, '# Throughline: session closed\n', 'utf8')
      }
    } finally {
      this._releaseLock()
    }
  }

  getLastSession(): IntentGraph | null {
    try {
      if (!fs.existsSync(this.historyDir)) return null
      const files = this._readDir(this.historyDir)
        .filter(f => f.endsWith('.yml'))
        .sort()
        .reverse()
      if (files.length === 0) return null
      return this._readYamlFile(path.join(this.historyDir, files[0]))
    } catch (err) {
      console.error(`[throughline] Failed to read last session: ${(err as Error).message}`)
      return null
    }
  }

  getSessionById(id: string): IntentGraph | null {
    try {
      const filePath = path.join(this.historyDir, `${id}.yml`)
      if (!fs.existsSync(filePath)) return null
      return this._readYamlFile(filePath)
    } catch (err) {
      console.error(`[throughline] Failed to read session ${id}: ${(err as Error).message}`)
      return null
    }
  }

  listSessions(): IntentGraph[] {
    try {
      if (!fs.existsSync(this.historyDir)) return []
      return this._readDir(this.historyDir)
        .filter(f => f.endsWith('.yml'))
        .sort()
        .reverse()
        .map(f => this._readYamlFileSafe(path.join(this.historyDir, f)))
        .filter((s): s is IntentGraph => s !== null)
    } catch (err) {
      console.error(`[throughline] Failed to list sessions: ${(err as Error).message}`)
      return []
    }
  }

  addNote(text: string, source: 'developer' | 'ai' = 'developer', category?: string): void {
    const graph = this.read()
    graph.session.notes.push({ text, recorded_at: new Date().toISOString(), source, category })
    this.write(graph)
  }

  private nextSessionId(): string {
    try {
      if (!fs.existsSync(this.historyDir)) return 'session-001'
      const files = this._readDir(this.historyDir).filter(f => f.startsWith('session-'))
      if (files.length === 0) return 'session-001'
      const nums = files.map(f => parseInt(f.replace('session-', '').replace('.yml', ''))).filter(n => !isNaN(n))
      if (nums.length === 0) return 'session-001'
      const next = Math.max(...nums) + 1
      return `session-${String(next).padStart(3, '0')}`
    } catch (err) {
      console.error(`[throughline] Failed to generate session ID: ${(err as Error).message}`)
      return 'session-001'
    }
  }

  private _readYamlFile(filePath: string): IntentGraph {
    try {
      const raw = fs.readFileSync(filePath, 'utf8')
      const graph = yaml.load(raw)
      if (!graph || typeof graph !== 'object') {
        throw new Error(`Invalid YAML in ${filePath}`)
      }
      return graph as IntentGraph
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('Invalid YAML')) throw err
      throw new Error(`Failed to read ${path.basename(filePath)}: ${(err as Error).message}`)
    }
  }

  private _readYamlFileSafe(filePath: string): IntentGraph | null {
    try {
      return this._readYamlFile(filePath)
    } catch (err) {
      console.error(`[throughline] Skipping corrupt session file ${path.basename(filePath)}: ${(err as Error).message}`)
      return null
    }
  }

  private _readDir(dirPath: string): string[] {
    try {
      return fs.readdirSync(dirPath)
    } catch (err) {
      throw new Error(`Failed to read directory ${dirPath}: ${(err as Error).message}`)
    }
  }

  // ─── File locking ───────────────────────────────────────────────────────
  // Simple lock file (`.session.lock`) with retry and stale-lock cleanup
  // (5s TTL). Prevents concurrent writes from corrupting session.yml.

  private _lockFilePath(): string {
    return path.join(this.intentDir, LOCK_FILE)
  }

  private _acquireLock(): boolean {
    const lockFile = this._lockFilePath()
    for (let i = 0; i < LOCK_RETRIES; i++) {
      try {
        fs.writeFileSync(lockFile, '', { flag: 'wx' })
        return true
      } catch (err) {
        const nodeErr = err as NodeJS.ErrnoException
        if (nodeErr.code === 'EEXIST') {
          try {
            const stat = fs.statSync(lockFile)
            if (Date.now() - stat.mtimeMs > 5000) {
              fs.unlinkSync(lockFile)
              continue
            }
          } catch {}
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, LOCK_RETRY_MS)
          continue
        }
        return false
      }
    }
    return false
  }

  private _releaseLock(): void {
    try { fs.unlinkSync(this._lockFilePath()) } catch {}
  }

  // ─── Atomic write ───────────────────────────────────────────────────────
  // Writes to .tmp then renames to target. Prevents partial reads during
  // crashes. Throws a clear error on ENOSPC (disk full).
  private _writeAtomic(filePath: string, content: string): void {
    const tmpPath = filePath + '.tmp'
    try {
      fs.writeFileSync(tmpPath, content, 'utf8')
      fs.renameSync(tmpPath, filePath)
    } catch (err) {
      try { fs.unlinkSync(tmpPath) } catch {}
      const nodeErr = err as NodeJS.ErrnoException
      if (nodeErr.code === 'ENOSPC') {
        throw new Error(
          `Disk full: cannot write ${path.basename(filePath)}. Free disk space and retry.`
        )
      }
      throw new Error(`Failed to write ${path.basename(filePath)}: ${nodeErr.message}`)
    }
  }
}
