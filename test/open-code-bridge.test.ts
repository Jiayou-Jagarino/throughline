import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { OpenCodeBridge } from '../src/engine/OpenCodeBridge.js'

interface MockStore {
  rootDir: string
  hasActiveSession: ReturnType<typeof vi.fn>
  read: ReturnType<typeof vi.fn>
  write: ReturnType<typeof vi.fn>
  addNote: ReturnType<typeof vi.fn>
}

interface MockTracker {
  recordFileTouched: ReturnType<typeof vi.fn>
  completeStep: ReturnType<typeof vi.fn>
  getCurrentTask: ReturnType<typeof vi.fn>
  getCurrentStep: ReturnType<typeof vi.fn>
  addTasks: ReturnType<typeof vi.fn>
  setStepStatus: ReturnType<typeof vi.fn>
}

interface MockContextBuilder {
  writeContextFile: ReturnType<typeof vi.fn>
  contextFilePath: string
}

function createMockStore(overrides?: Partial<MockStore>): MockStore {
  return {
    rootDir: 'D:\\project',
    hasActiveSession: vi.fn().mockReturnValue(false),
    read: vi.fn().mockReturnValue({ session: { notes: [] }, tasks: [] }),
    write: vi.fn(),
    addNote: vi.fn(),
    ...overrides,
  }
}

function createMockTracker(overrides?: Partial<MockTracker>): MockTracker {
  return {
    recordFileTouched: vi.fn(),
    completeStep: vi.fn(),
    getCurrentTask: vi.fn().mockReturnValue(null),
    getCurrentStep: vi.fn().mockReturnValue(null),
    addTasks: vi.fn(),
    setStepStatus: vi.fn(),
    ...overrides,
  }
}

function createMockCtx(calls?: string[]): MockContextBuilder & { calls: typeof vi.fn } {
  const fn = vi.fn()
  return {
    writeContextFile: fn,
    contextFilePath: '.intent/context.txt',
    calls: fn,
  }
}

function createMockBridge(store?: MockStore, tracker?: MockTracker, ctx?: MockContextBuilder): OpenCodeBridge {
  const s = store ?? createMockStore()
  const t = tracker ?? createMockTracker()
  const c = ctx ?? createMockCtx()
  return new OpenCodeBridge({
    store: s as any,
    tracker: t as any,
    contextBuilder: c as any,
  })
}

function dispatch(bridge: OpenCodeBridge, type: string, properties?: Record<string, unknown>): void {
  const data = JSON.stringify({ type, properties })
  ;(bridge as any).handleEvent(data)
}

describe('OpenCodeBridge SSE event dispatch', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('session.created', () => {
    it('fires onSessionCreated callback', () => {
      const bridge = createMockBridge()
      const fn = vi.fn()
      ;(bridge as any).opts.onSessionCreated = fn
      dispatch(bridge, 'session.created', { sessionID: 'ses_abc123' })
      expect(fn).toHaveBeenCalledWith('ses_abc123')
    })

    it('reads sessionID from properties', () => {
      const bridge = createMockBridge()
      const fn = vi.fn()
      ;(bridge as any).opts.onSessionCreated = fn
      dispatch(bridge, 'session.created', { id: 'ses_xyz' })
      expect(fn).toHaveBeenCalledWith('ses_xyz')
    })
  })

  describe('session.idle', () => {
    it('fires onSessionIdle callback', () => {
      const bridge = createMockBridge()
      const fn = vi.fn()
      ;(bridge as any).opts.onSessionIdle = fn
      dispatch(bridge, 'session.idle')
      expect(fn).toHaveBeenCalled()
    })

    it('writes context file', () => {
      const ctx = createMockCtx()
      const bridge = createMockBridge(undefined, undefined, ctx)
      dispatch(bridge, 'session.idle')
      expect(ctx.writeContextFile).toHaveBeenCalledWith('session-idle')
    })
  })

  describe('session.status', () => {
    it('fires onSessionIdle when type is idle', () => {
      const bridge = createMockBridge()
      const fn = vi.fn()
      ;(bridge as any).opts.onSessionIdle = fn
      dispatch(bridge, 'session.status', { status: { type: 'idle' } })
      expect(fn).toHaveBeenCalled()
    })

    it('does nothing when status type is not idle', () => {
      const bridge = createMockBridge()
      const fn = vi.fn()
      ;(bridge as any).opts.onSessionIdle = fn
      dispatch(bridge, 'session.status', { status: { type: 'busy' } })
      expect(fn).not.toHaveBeenCalled()
    })
  })

  describe('message.part.updated — text', () => {
    it('parses PLAN marker from text part', () => {
      const store = createMockStore({ hasActiveSession: vi.fn().mockReturnValue(true) })
      const bridge = createMockBridge(store)
      dispatch(bridge, 'message.part.updated', {
        part: {
          type: 'text',
          text: '[THROUGHLINE:PLAN]{"tasks":[{"intent":"test","steps":[]}]}[/THROUGHLINE:PLAN]',
        },
      })
      expect(store.read).toHaveBeenCalled()
    })

    it('parses NOTE marker from text part', () => {
      const store = createMockStore()
      const bridge = createMockBridge(store)
      dispatch(bridge, 'message.part.updated', {
        part: {
          type: 'text',
          text: '[THROUGHLINE:NOTE text="test note" category="insight"]',
        },
      })
      expect(store.addNote).toHaveBeenCalledWith('test note', 'ai', 'insight')
    })

    it('parses STEP_DONE marker from text part', () => {
      const step = { id: 's1', status: 'in_progress' as const }
      const task = { id: 't1', steps: [step] }
      const store = createMockStore({
        read: vi.fn().mockReturnValue({ session: { notes: [] }, tasks: [task] }),
      })
      const tracker = createMockTracker({
        getCurrentTask: vi.fn().mockReturnValue(task),
        getCurrentStep: vi.fn().mockReturnValue(step),
      })
      const ctx = createMockCtx()
      const bridge = createMockBridge(store, tracker, ctx)

      dispatch(bridge, 'message.part.updated', {
        part: { type: 'text', text: '[THROUGHLINE:STEP_DONE]' },
      })
      expect(tracker.completeStep).toHaveBeenCalledWith('t1', 's1')
      expect(ctx.writeContextFile).toHaveBeenCalledWith('step-done')
    })

    it('ignores text part with no markers', () => {
      const store = createMockStore()
      const bridge = createMockBridge(store)
      dispatch(bridge, 'message.part.updated', {
        part: { type: 'text', text: 'just a regular message' },
      })
      expect(store.addNote).not.toHaveBeenCalled()
    })
  })

  describe('message.part.updated — tool (write)', () => {
    it('records file touch on write completed', () => {
      const tracker = createMockTracker()
      const bridge = createMockBridge(undefined, tracker)
      dispatch(bridge, 'message.part.updated', {
        part: {
          type: 'tool',
          tool: 'write',
          state: { status: 'completed', input: { filePath: 'D:\\project\\src\\hello.ts' } },
        },
      })
      expect(tracker.recordFileTouched).toHaveBeenCalledWith('src\\hello.ts')
    })

    it('records file touch with relative path', () => {
      const tracker = createMockTracker()
      const bridge = createMockBridge(undefined, tracker)
      dispatch(bridge, 'message.part.updated', {
        part: {
          type: 'tool',
          tool: 'write',
          state: { status: 'completed', input: { path: 'D:\\project\\foo\\bar.ts' } },
        },
      })
      expect(tracker.recordFileTouched).toHaveBeenCalledWith('foo\\bar.ts')
    })

    it('does not record file touch when status is running', () => {
      const tracker = createMockTracker()
      const bridge = createMockBridge(undefined, tracker)
      dispatch(bridge, 'message.part.updated', {
        part: {
          type: 'tool',
          tool: 'write',
          state: { status: 'running', input: { filePath: 'D:\\project\\tmp.ts' } },
        },
      })
      expect(tracker.recordFileTouched).not.toHaveBeenCalled()
    })

    it('logs error when write tool has no filePath', () => {
      const spy = vi.spyOn(console, 'error')
      const bridge = createMockBridge()
      dispatch(bridge, 'message.part.updated', {
        part: {
          type: 'tool',
          tool: 'write',
          state: { status: 'completed', input: {} },
        },
      })
      expect(spy).toHaveBeenCalledWith(expect.stringContaining('no filePath'))
    })
  })

  describe('message.part.updated — tool (read)', () => {
    it('records file touch on read (no status check)', () => {
      const tracker = createMockTracker()
      const bridge = createMockBridge(undefined, tracker)
      dispatch(bridge, 'message.part.updated', {
        part: {
          type: 'tool',
          tool: 'read',
          state: { status: 'running', input: { filePath: 'D:\\project\\readme.md' } },
        },
      })
      expect(tracker.recordFileTouched).toHaveBeenCalledWith('readme.md')
    })
  })

  describe('message.part.updated — tool (bash)', () => {
    it('records file touch when shell writes a file', () => {
      const tracker = createMockTracker()
      const bridge = createMockBridge(undefined, tracker)
      dispatch(bridge, 'message.part.updated', {
        part: {
          type: 'tool',
          tool: 'bash',
          state: { status: 'completed', input: { command: 'New-Item -Path test.txt' } },
        },
      })
      expect(tracker.recordFileTouched).toHaveBeenCalledWith('test.txt')
    })

    it('detects Out-File in PowerShell commands', () => {
      const tracker = createMockTracker()
      const bridge = createMockBridge(undefined, tracker)
      dispatch(bridge, 'message.part.updated', {
        part: {
          type: 'tool',
          tool: 'bash',
          state: { status: 'completed', input: { command: 'Get-Process | Out-File -FilePath proc.txt' } },
        },
      })
      expect(tracker.recordFileTouched).toHaveBeenCalledWith('proc.txt')
    })

    it('detects Set-Content in PowerShell commands', () => {
      const tracker = createMockTracker()
      const bridge = createMockBridge(undefined, tracker)
      dispatch(bridge, 'message.part.updated', {
        part: {
          type: 'tool',
          tool: 'bash',
          state: { status: 'completed', input: { command: "Set-Content -Path notes.txt 'hello'" } },
        },
      })
      expect(tracker.recordFileTouched).toHaveBeenCalledWith('notes.txt')
    })

    it('detects git add/commit commands', () => {
      const ctx = createMockCtx()
      const bridge = createMockBridge(undefined, undefined, ctx)
      dispatch(bridge, 'message.part.updated', {
        part: {
          type: 'tool',
          tool: 'bash',
          state: { status: 'completed', input: { command: 'git add .' } },
        },
      })
      expect(ctx.writeContextFile).toHaveBeenCalledWith('git-op')
    })

    it('does nothing when bash has no command', () => {
      const tracker = createMockTracker()
      const bridge = createMockBridge(undefined, tracker)
      dispatch(bridge, 'message.part.updated', {
        part: {
          type: 'tool',
          tool: 'bash',
          state: { status: 'completed', input: {} },
        },
      })
      expect(tracker.recordFileTouched).not.toHaveBeenCalled()
    })
  })

  describe('message.part.updated — tool (todowrite)', () => {
    it('syncs todos from payload', () => {
      const bridge = createMockBridge()
      const fn = vi.fn()
      ;(bridge as any).opts.onTodoUpdate = fn
      dispatch(bridge, 'message.part.updated', {
        part: {
          type: 'tool',
          tool: 'todowrite',
          state: { status: 'completed', input: { todos: [{ id: '1', content: 'test', status: 'pending', priority: 'low' }] } },
        },
      })
      expect(fn).toHaveBeenCalledWith([{ id: '1', content: 'test', status: 'pending', priority: 'low' }])
    })

    it('does not sync empty todos', () => {
      const bridge = createMockBridge()
      const fn = vi.fn()
      ;(bridge as any).opts.onTodoUpdate = fn
      dispatch(bridge, 'message.part.updated', {
        part: {
          type: 'tool',
          tool: 'todowrite',
          state: { status: 'completed', input: { todos: [] } },
        },
      })
      expect(fn).not.toHaveBeenCalled()
    })
  })

  describe('message.part.updated — tool (unknown)', () => {
    it('logs unhandled tool event', () => {
      const bridge = createMockBridge()
      dispatch(bridge, 'message.part.updated', {
        part: {
          type: 'tool',
          tool: 'some_random_tool',
          state: { status: 'completed', input: { foo: 'bar' } },
        },
      })
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('some_random_tool'),
      )
    })
  })

  describe('message.part.delta', () => {
    it('handles delta events same as updated', () => {
      const store = createMockStore()
      const bridge = createMockBridge(store)
      const data = JSON.stringify({
        type: 'message.part.delta',
        properties: { part: { type: 'text', text: '[THROUGHLINE:NOTE text="delta note" category="context"]' } },
      })
      ;(bridge as any).handleEvent(data)
      expect(store.addNote).toHaveBeenCalledWith('delta note', 'ai', 'context')
    })
  })

  describe('malformed or no-op events', () => {
    it('skips empty data', () => {
      const bridge = createMockBridge()
      expect(() => (bridge as any).handleEvent('')).not.toThrow()
    })

    it('skips invalid JSON', () => {
      const bridge = createMockBridge()
      expect(() => (bridge as any).handleEvent('not json')).not.toThrow()
    })

    it('ignores message.part.updated with no part', () => {
      const tracker = createMockTracker()
      const bridge = createMockBridge(undefined, tracker)
      dispatch(bridge, 'message.part.updated', {} as any)
      expect(tracker.recordFileTouched).not.toHaveBeenCalled()
    })

    it('ignores message.part.updated with part but no content', () => {
      const tracker = createMockTracker()
      const bridge = createMockBridge(undefined, tracker)
      dispatch(bridge, 'message.part.updated', { part: {} } as any)
      expect(tracker.recordFileTouched).not.toHaveBeenCalled()
    })

    it('ignores unknown event types', () => {
      const tracker = createMockTracker()
      const bridge = createMockBridge(undefined, tracker)
      dispatch(bridge, 'some.unknown.event')
      expect(tracker.recordFileTouched).not.toHaveBeenCalled()
    })
  })
})
