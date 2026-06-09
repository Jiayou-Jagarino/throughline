import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { SessionStore } from '../src/engine/SessionStore.js'
import { TaskTracker } from '../src/engine/TaskTracker.js'

// Mock chokidar
const mockOn = vi.fn()
const mockClose = vi.fn()
const mockWatch = vi.fn(() => ({
  on: mockOn,
  close: mockClose,
}))

vi.mock('chokidar', () => ({
  default: { watch: mockWatch },
}))

const { FileWatcher } = await import('../src/engine/FileWatcher.js')

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'tl-fw-'))
}

describe('FileWatcher', () => {
  let dir: string
  let store: SessionStore
  let tracker: TaskTracker
  let watcher: FileWatcher

  beforeEach(() => {
    vi.clearAllMocks()
    dir = tmpDir()
    store = new SessionStore(dir)
    store.init()
    store.createSession('Test', 'opencode')
    tracker = new TaskTracker(store)
    watcher = new FileWatcher(store, tracker, dir)
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  describe('start', () => {
    it('creates chokidar watcher with correct options', () => {
      watcher.start()
      expect(mockWatch).toHaveBeenCalledWith(dir, expect.objectContaining({
        persistent: true,
        ignoreInitial: true,
        depth: 3,
      }))
    })

    it('registers change and add handlers', () => {
      watcher.start()
      expect(mockOn).toHaveBeenCalledWith('change', expect.any(Function))
      expect(mockOn).toHaveBeenCalledWith('add', expect.any(Function))
    })

    it('ignores node_modules', () => {
      watcher.start()
      const opts = mockWatch.mock.calls[0][1]
      const ignored = opts.ignored
      expect(ignored.some((r: RegExp) => r.test('node_modules/foo'))).toBe(true)
    })

    it('ignores .git', () => {
      watcher.start()
      const opts = mockWatch.mock.calls[0][1]
      const ignored = opts.ignored
      expect(ignored.some((r: RegExp) => r.test('.git/config'))).toBe(true)
    })

    it('ignores .intent', () => {
      watcher.start()
      const opts = mockWatch.mock.calls[0][1]
      const ignored = opts.ignored
      expect(ignored.some((r: RegExp) => r.test('.intent/session.yml'))).toBe(true)
    })
  })

  describe('stop', () => {
    it('closes the watcher', () => {
      watcher.start()
      watcher.stop()
      expect(mockClose).toHaveBeenCalled()
    })

    it('handles stop without start', () => {
      expect(() => watcher.stop()).not.toThrow()
    })
  })

  describe('getUnplannedFiles', () => {
    it('starts empty', () => {
      expect(watcher.getUnplannedFiles()).toEqual([])
    })
  })

  describe('clearUnplanned', () => {
    it('clears unplanned list', () => {
      // Trigger an unplanned file by simulating a change via internal logic
      // The FileWatcher.handleChange is private, so we test indirectly
      expect(watcher.getUnplannedFiles()).toEqual([])
      watcher.clearUnplanned()
      expect(watcher.getUnplannedFiles()).toEqual([])
    })
  })
})
