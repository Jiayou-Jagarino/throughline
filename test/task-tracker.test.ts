import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { SessionStore } from '../src/engine/SessionStore.js'
import { TaskTracker } from '../src/engine/TaskTracker.js'

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'tl-tt-'))
}

function makeStore(dir: string): SessionStore {
  const s = new SessionStore(dir)
  s.init()
  s.createSession('Test', 'opencode')
  return s
}

describe('TaskTracker', () => {
  let dir: string
  let store: SessionStore
  let tracker: TaskTracker

  beforeEach(() => {
    dir = tmpDir()
    store = makeStore(dir)
    tracker = new TaskTracker(store)
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  describe('addTasks', () => {
    it('adds tasks to the graph', () => {
      const graph = tracker.addTasks([{
        intent: 'Build feature',
        declared_by: 'ai',
        status: 'pending',
        depends_on: [],
        steps: [{ intent: 'Write code', declared_by: 'ai', status: 'pending', files: { planned: ['src/main.ts'], touched: [] }, deviation: null, completed_at: null }],
      }])
      expect(graph.tasks).toHaveLength(1)
      expect(graph.tasks[0].intent).toBe('Build feature')
    })

    it('assigns sequential IDs', () => {
      tracker.addTasks([{ intent: 'T1', declared_by: 'ai', status: 'pending', depends_on: [], steps: [{ intent: 'S1', declared_by: 'ai', status: 'pending', files: { planned: [], touched: [] }, deviation: null, completed_at: null }] }])
      tracker.addTasks([{ intent: 'T2', declared_by: 'ai', status: 'pending', depends_on: [], steps: [{ intent: 'S2', declared_by: 'ai', status: 'pending', files: { planned: [], touched: [] }, deviation: null, completed_at: null }] }])
      const graph = store.read()
      expect(graph.tasks[0].id).toBe('t1')
      expect(graph.tasks[1].id).toBe('t2')
    })

    it('assigns step IDs', () => {
      tracker.addTasks([{
        intent: 'T', declared_by: 'ai', status: 'pending', depends_on: [],
        steps: [
          { intent: 'S1', declared_by: 'ai', status: 'pending', files: { planned: [], touched: [] }, deviation: null, completed_at: null },
          { intent: 'S2', declared_by: 'ai', status: 'pending', files: { planned: [], touched: [] }, deviation: null, completed_at: null },
        ],
      }])
      const graph = store.read()
      expect(graph.tasks[0].steps[0].id).toBe('t1-s1')
      expect(graph.tasks[0].steps[1].id).toBe('t1-s2')
    })

    it('sets session status to in_progress', () => {
      tracker.addTasks([{ intent: 'T', declared_by: 'ai', status: 'pending', depends_on: [], steps: [{ intent: 'S', declared_by: 'ai', status: 'pending', files: { planned: [], touched: [] }, deviation: null, completed_at: null }] }])
      expect(store.read().session.status).toBe('in_progress')
    })
  })

  describe('completeStep', () => {
    beforeEach(() => {
      tracker.addTasks([{ intent: 'T', declared_by: 'ai', status: 'pending', depends_on: [], steps: [{ intent: 'S', declared_by: 'ai', status: 'pending', files: { planned: [], touched: [] }, deviation: null, completed_at: null }] }])
    })

    it('marks step as complete', () => {
      tracker.completeStep('t1', 't1-s1')
      const graph = store.read()
      expect(graph.tasks[0].steps[0].status).toBe('complete')
    })

    it('sets completed_at timestamp', () => {
      tracker.completeStep('t1', 't1-s1')
      const graph = store.read()
      expect(graph.tasks[0].steps[0].completed_at).not.toBeNull()
    })

    it('marks task complete when all steps done', () => {
      tracker.completeStep('t1', 't1-s1')
      expect(store.read().tasks[0].status).toBe('complete')
    })

    it('marks session complete when all tasks done', () => {
      tracker.completeStep('t1', 't1-s1')
      expect(store.read().session.status).toBe('complete')
    })

    it('throws for unknown task', () => {
      expect(() => tracker.completeStep('t99', 't1-s1')).toThrow('Task t99 not found')
    })

    it('throws for unknown step', () => {
      expect(() => tracker.completeStep('t1', 't99')).toThrow('Step t99 not found')
    })
  })

  describe('setStepStatus', () => {
    beforeEach(() => {
      tracker.addTasks([{ intent: 'T', declared_by: 'ai', status: 'pending', depends_on: [], steps: [{ intent: 'S', declared_by: 'ai', status: 'pending', files: { planned: [], touched: [] }, deviation: null, completed_at: null }] }])
    })

    it('sets step status', () => {
      tracker.setStepStatus('t1', 't1-s1', 'in_progress')
      expect(store.read().tasks[0].steps[0].status).toBe('in_progress')
    })

    it('sets task to in_progress when step starts', () => {
      tracker.setStepStatus('t1', 't1-s1', 'in_progress')
      expect(store.read().tasks[0].status).toBe('in_progress')
    })

    it('returns silently for unknown task', () => {
      expect(() => tracker.setStepStatus('t99', 't1-s1', 'complete')).not.toThrow()
    })
  })

  describe('recordDeviation', () => {
    beforeEach(() => {
      tracker.addTasks([{ intent: 'T', declared_by: 'ai', status: 'in_progress', depends_on: [], steps: [{ intent: 'S', declared_by: 'ai', status: 'in_progress', files: { planned: [], touched: [] }, deviation: null, completed_at: null }] }])
    })

    it('marks step as deviated', () => {
      tracker.recordDeviation('t1', 't1-s1', { reason: 'changed', spawned_task: null, recorded_at: new Date().toISOString() })
      expect(store.read().tasks[0].steps[0].status).toBe('deviated')
    })

    it('marks task as deviated', () => {
      tracker.recordDeviation('t1', 't1-s1', { reason: 'changed', spawned_task: null, recorded_at: new Date().toISOString() })
      expect(store.read().tasks[0].status).toBe('deviated')
    })

    it('creates spawned task when spawns provided', () => {
      tracker.recordDeviation('t1', 't1-s1', { reason: 'split', spawned_task: 'New work', recorded_at: new Date().toISOString() })
      const graph = store.read()
      expect(graph.tasks).toHaveLength(2)
      expect(graph.tasks[1].intent).toBe('New work')
    })

    it('throws for unknown task', () => {
      expect(() => tracker.recordDeviation('t99', 't1-s1', { reason: 'x', spawned_task: null, recorded_at: '' })).toThrow('Task t99 not found')
    })
  })

  describe('recordFileTouched', () => {
    beforeEach(() => {
      tracker.addTasks([{ intent: 'T', declared_by: 'ai', status: 'in_progress', depends_on: [], steps: [{ intent: 'S', declared_by: 'ai', status: 'in_progress', files: { planned: [], touched: [] }, deviation: null, completed_at: null }] }])
    })

    it('records touched file on current step', () => {
      tracker.recordFileTouched('src/main.ts')
      const graph = store.read()
      expect(graph.tasks[0].steps[0].files.touched).toContain('src/main.ts')
    })

    it('does not duplicate file entries', () => {
      tracker.recordFileTouched('src/main.ts')
      tracker.recordFileTouched('src/main.ts')
      const graph = store.read()
      expect(graph.tasks[0].steps[0].files.touched).toHaveLength(1)
    })
  })

  describe('getCurrentTask', () => {
    it('returns undefined with no tasks', () => {
      expect(tracker.getCurrentTask()).toBeUndefined()
    })

    it('returns in_progress task', () => {
      tracker.addTasks([{ intent: 'T', declared_by: 'ai', status: 'in_progress', depends_on: [], steps: [{ intent: 'S', declared_by: 'ai', status: 'in_progress', files: { planned: [], touched: [] }, deviation: null, completed_at: null }] }])
      const task = tracker.getCurrentTask()
      expect(task).toBeDefined()
      expect(task!.intent).toBe('T')
    })
  })

  describe('getCurrentStep', () => {
    it('returns undefined with no tasks', () => {
      expect(tracker.getCurrentStep()).toBeUndefined()
    })

    it('returns in_progress step', () => {
      tracker.addTasks([{ intent: 'T', declared_by: 'ai', status: 'in_progress', depends_on: [], steps: [{ intent: 'S', declared_by: 'ai', status: 'in_progress', files: { planned: [], touched: [] }, deviation: null, completed_at: null }] }])
      const step = tracker.getCurrentStep()
      expect(step).toBeDefined()
      expect(step!.intent).toBe('S')
    })
  })
})
