import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { SessionStore } from '../src/engine/SessionStore.js'
import { ContextBuilder } from '../src/engine/ContextBuilder.js'
import { TaskTracker } from '../src/engine/TaskTracker.js'

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'tl-e2e-'))
}

describe('E2E: full session lifecycle', () => {
  let dir: string
  let store: SessionStore
  let tracker: TaskTracker
  let ctx: ContextBuilder

  beforeEach(() => {
    dir = tmpDir()
    store = new SessionStore(dir)
    store.init()
    ctx = new ContextBuilder(store)
    tracker = new TaskTracker(store)
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('init → start → plan → step → deviate → note → close', () => {
    // ── 1. Init ──
    expect(existsSync(join(dir, '.intent'))).toBe(true)

    // ── 2. Start session ──
    const graph = store.createSession('Refactor auth module', 'opencode')
    expect(graph.session.goal).toBe('Refactor auth module')
    expect(graph.session.status).toBe('pending')
    expect(existsSync(store.sessionFile)).toBe(true)

    ctx.writeContextFile('session-start')
    let contextContent = readFileSync(ctx.contextFilePath, 'utf8')
    expect(contextContent).toContain('Refactor auth module')
    expect(contextContent).toContain('Status: pending')

    // ── 3. Agent captures plan ──
    tracker.addTasks([{
      intent: 'Extract auth logic',
      declared_by: 'ai',
      status: 'in_progress',
      depends_on: [],
      steps: [
        { intent: 'Create AuthService class', declared_by: 'ai', status: 'in_progress', files: { planned: ['src/auth/AuthService.ts'], touched: [] }, deviation: null, completed_at: null },
        { intent: 'Add JWT helpers', declared_by: 'ai', status: 'pending', files: { planned: ['src/auth/jwt.ts'], touched: [] }, deviation: null, completed_at: null },
        { intent: 'Write tests', declared_by: 'ai', status: 'pending', files: { planned: ['src/auth/__tests__/auth.test.ts'], touched: [] }, deviation: null, completed_at: null },
      ],
    }])
    tracker.setStepStatus('t1', 't1-s1', 'in_progress')

    ctx.writeContextFile('plan-captured')
    contextContent = readFileSync(ctx.contextFilePath, 'utf8')
    expect(contextContent).toContain('Extract auth logic')
    expect(contextContent).toContain('Create AuthService class')
    expect(contextContent).toContain('Add JWT helpers')
    expect(contextContent).toContain('Write tests')
    expect(contextContent).toContain('Status: in_progress')

    // ── 4. Step done → advance to next step ──
    tracker.completeStep('t1', 't1-s1')
    tracker.setStepStatus('t1', 't1-s2', 'in_progress')

    ctx.writeContextFile('step-done')
    contextContent = readFileSync(ctx.contextFilePath, 'utf8')
    expect(contextContent).toContain('✓ Create AuthService class')
    expect(contextContent).toContain('Current step: Add JWT helpers')
    expect(contextContent).toContain('· Write tests')

    // ── 5. Deviation with spawned task ──
    tracker.recordDeviation('t1', 't1-s2', {
      reason: 'JWT library requires config setup first',
      spawned_task: 'Configure JWT environment',
      recorded_at: new Date().toISOString(),
    })

    ctx.writeContextFile('deviation')
    contextContent = readFileSync(ctx.contextFilePath, 'utf8')
    expect(contextContent).toContain('Deviations recorded')

    const updatedGraph = store.read()
    expect(updatedGraph.tasks).toHaveLength(2)
    expect(updatedGraph.tasks[1].intent).toBe('Configure JWT environment')

    // ── 6. Note ──
    store.addNote('Use RS256 algorithm for JWT', 'developer', 'decision')

    ctx.writeContextFile('note')
    contextContent = readFileSync(ctx.contextFilePath, 'utf8')
    expect(contextContent).toContain('Key decisions')
    expect(contextContent).toContain('Use RS256 algorithm for JWT')

    // ── 7. Close session ──
    store.closeSession('complete')

    expect(existsSync(store.sessionFile)).toBe(false)
    const last = store.getLastSession()
    expect(last).not.toBeNull()
    expect(last!.session.status).toBe('complete')
    expect(last!.session.goal).toBe('Refactor auth module')
    expect(last!.session.notes).toHaveLength(1)

    // ── 8. Audit log ──
    const audit = readFileSync(store.intentDir + '/context-audit.log', 'utf8')
    expect(audit).toContain('trigger=session-start')
    expect(audit).toContain('trigger=plan-captured')
    expect(audit).toContain('trigger=step-done')
    expect(audit).toContain('trigger=deviation')
    expect(audit).toContain('trigger=note')
  })
})
