import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { SessionStore } from '../src/engine/SessionStore.js'
import { ContextBuilder } from '../src/engine/ContextBuilder.js'

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'tl-ctx-'))
}

describe('ContextBuilder', () => {
  let dir: string
  let store: SessionStore
  let ctx: ContextBuilder

  beforeEach(() => {
    dir = tmpDir()
    store = new SessionStore(dir)
    store.init()
    store.createSession('Test goal', 'opencode')
    ctx = new ContextBuilder(store)
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  describe('buildContextBlock', () => {
    it('includes session goal and status', () => {
      const block = ctx.buildContextBlock()
      expect(block).toContain('[THROUGHLINE CONTEXT]')
      expect(block).toContain('Test goal')
      expect(block).toContain('Status: pending')
      expect(block).toContain('[/THROUGHLINE CONTEXT]')
    })

    it('shows no completed tasks initially', () => {
      const block = ctx.buildContextBlock()
      expect(block).not.toContain('Completed tasks')
    })

    it('shows deviation count when present', () => {
      // Add a deviated step
      const graph = store.read()
      graph.tasks.push({
        id: 't1',
        intent: 'Task',
        declared_by: 'ai',
        status: 'deviated',
        depends_on: [],
        steps: [{
          id: 't1-s1',
          intent: 'Step',
          declared_by: 'ai',
          status: 'deviated',
          files: { planned: [], touched: [] },
          deviation: { reason: 'changed', spawned_task: null, recorded_at: new Date().toISOString() },
          completed_at: null,
        }],
      })
      store.write(graph)

      const block = ctx.buildContextBlock()
      expect(block).toContain('Deviations recorded')
    })

    it('shows session notes', () => {
      store.addNote('important note', 'developer', 'decision')
      const block = ctx.buildContextBlock()
      expect(block).toContain('Key decisions')
      expect(block).toContain('important note')
    })

    it('does not contain "undefined"', () => {
      const block = ctx.buildContextBlock()
      expect(block).not.toContain('undefined')
    })
  })

  describe('buildContextBlock with parent', () => {
    it('includes parent session info', () => {
      // Create a parent session in history
      const parentStore = new SessionStore(store.intentDir.replace(/\\[^\\/]*$/, ''))
      // Actually the parent must be in the same store's history
      // Let's create a parent manually
      const parentGraph = store.createSession('Parent goal', 'opencode')
      store.closeSession('complete')

      // Now create a new session with parent reference
      store.createSession('Child goal', 'opencode', { id: parentGraph.session.id, relation: 'continue' })

      const block = ctx.buildContextBlock(parentGraph)
      expect(block).toContain('Parent goal')
      expect(block).toContain('continue')
    })
  })

  describe('writeContextFile', () => {
    it('creates context.txt', () => {
      ctx.writeContextFile('test')
      expect(existsSync(ctx.contextFilePath)).toBe(true)
    })

    it('writes valid context block', () => {
      ctx.writeContextFile('test')
      const content = readFileSync(ctx.contextFilePath, 'utf8')
      expect(content).toContain('[THROUGHLINE CONTEXT]')
      expect(content).toContain('[/THROUGHLINE CONTEXT]')
    })

    it('creates audit log entry', () => {
      ctx.writeContextFile('test-trigger')
      const audit = readFileSync(ctx.auditLogPath, 'utf8')
      expect(audit).toContain('trigger=test-trigger')
      expect(audit).toContain('size=')
    })
  })

  describe('logContextRead', () => {
    it('writes to audit log', () => {
      ctx.logContextRead('agent')
      const audit = readFileSync(ctx.auditLogPath, 'utf8')
      expect(audit).toContain('trigger=context-read')
      expect(audit).toContain('source=agent')
    })

    it('supports different sources', () => {
      ctx.logContextRead('mcp')
      const audit = readFileSync(ctx.auditLogPath, 'utf8')
      expect(audit).toContain('source=mcp')
    })
  })
})
