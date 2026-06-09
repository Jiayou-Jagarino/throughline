import fs from 'fs'
import path from 'path'
import yaml from 'js-yaml'
import type { IntentGraph, Agent, SessionRelation } from '../types.js'

const INTENT_DIR = '.intent'
const SESSION_FILE = 'session.yml'
const HISTORY_DIR = 'history'

export class SessionStore {
  private root: string

  constructor(cwd: string = process.cwd()) {
    this.root = cwd
  }

  get intentDir() { return path.join(this.root, INTENT_DIR) }
  get sessionFile() { return path.join(this.intentDir, SESSION_FILE) }
  get historyDir() { return path.join(this.intentDir, HISTORY_DIR) }

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
    const raw = fs.readFileSync(this.sessionFile, 'utf8')
    return yaml.load(raw) as IntentGraph
  }

  write(graph: IntentGraph): void {
    fs.writeFileSync(this.sessionFile, yaml.dump(graph, { lineWidth: 120 }), 'utf8')
  }

  createSession(goal: string, agent: Agent = 'claude-code', parent?: { id: string; relation: SessionRelation }): IntentGraph {
    const id = this.nextSessionId()
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

  closeSession(status: 'complete' | 'abandoned' = 'complete'): void {
    const graph = this.read()
    graph.session.status = status
    graph.session.closed_at = new Date().toISOString()

    const archivePath = path.join(this.historyDir, `${graph.session.id}.yml`)
    fs.writeFileSync(archivePath, yaml.dump(graph, { lineWidth: 120 }), 'utf8')
    fs.unlinkSync(this.sessionFile)
  }

  getLastSession(): IntentGraph | null {
    if (!fs.existsSync(this.historyDir)) return null
    const files = fs.readdirSync(this.historyDir)
      .filter(f => f.endsWith('.yml'))
      .sort()
      .reverse()
    if (files.length === 0) return null
    const raw = fs.readFileSync(path.join(this.historyDir, files[0]), 'utf8')
    return yaml.load(raw) as IntentGraph
  }

  getSessionById(id: string): IntentGraph | null {
    const filePath = path.join(this.historyDir, `${id}.yml`)
    if (!fs.existsSync(filePath)) return null
    const raw = fs.readFileSync(filePath, 'utf8')
    return yaml.load(raw) as IntentGraph
  }

  listSessions(): IntentGraph[] {
    if (!fs.existsSync(this.historyDir)) return []
    return fs.readdirSync(this.historyDir)
      .filter(f => f.endsWith('.yml'))
      .sort()
      .reverse()
      .map(f => yaml.load(fs.readFileSync(path.join(this.historyDir, f), 'utf8')) as IntentGraph)
  }

  addNote(text: string, source: 'developer' | 'ai' = 'developer', category?: string): void {
    const graph = this.read()
    graph.session.notes.push({ text, recorded_at: new Date().toISOString(), source, category })
    this.write(graph)
  }

  private nextSessionId(): string {
    if (!fs.existsSync(this.historyDir)) return 'session-001'
    const files = fs.readdirSync(this.historyDir).filter(f => f.startsWith('session-'))
    if (files.length === 0) return 'session-001'
    const nums = files.map(f => parseInt(f.replace('session-', '').replace('.yml', ''))).filter(n => !isNaN(n))
    const next = Math.max(...nums) + 1
    return `session-${String(next).padStart(3, '0')}`
  }
}
