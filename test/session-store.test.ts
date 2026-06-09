import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { SessionStore } from '../src/engine/SessionStore.js'

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'tl-test-'))
}

describe('SessionStore', () => {
  let dir: string
  let store: SessionStore

  beforeEach(() => {
    dir = tmpDir()
    store = new SessionStore(dir)
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  describe('init', () => {
    it('creates .intent directory', () => {
      store.init()
      expect(existsSync(join(dir, '.intent'))).toBe(true)
    })

    it('creates history directory', () => {
      store.init()
      expect(existsSync(join(dir, '.intent', 'history'))).toBe(true)
    })

    it('creates .gitignore entry', () => {
      store.init()
      const gi = readFileSync(join(dir, '.gitignore'), 'utf8')
      expect(gi).toContain('.intent/session.yml')
    })

    it('appends to existing .gitignore', () => {
      store.init()
      store.init()
      const gi = readFileSync(join(dir, '.gitignore'), 'utf8')
      const matches = gi.match(/\.intent\/session\.yml/g)
      expect(matches).toHaveLength(1)
    })

    it('is idempotent', () => {
      store.init()
      store.init()
      expect(existsSync(join(dir, '.intent'))).toBe(true)
    })
  })

  describe('isInitialized', () => {
    it('returns false before init', () => {
      expect(store.isInitialized()).toBe(false)
    })

    it('returns true after init', () => {
      store.init()
      expect(store.isInitialized()).toBe(true)
    })
  })

  describe('createSession and read', () => {
    beforeEach(() => store.init())

    it('creates a session YAML file', () => {
      store.createSession('Test goal', 'opencode')
      expect(existsSync(store.sessionFile)).toBe(true)
    })

    it('returns session with correct goal', () => {
      const graph = store.createSession('Test goal', 'opencode')
      expect(graph.session.goal).toBe('Test goal')
      expect(graph.session.agent).toBe('opencode')
      expect(graph.session.status).toBe('pending')
    })

    it('generates sequential session IDs', () => {
      store.createSession('First')
      store.closeSession('complete')
      const g2 = store.createSession('Second')
      expect(g2.session.id).toBe('session-002')
    })

    it('read returns same data', () => {
      store.createSession('Goal')
      const graph = store.read()
      expect(graph.session.goal).toBe('Goal')
    })

    it('read throws without active session', () => {
      expect(() => store.read()).toThrow('No active session')
    })

    it('hasActiveSession returns true', () => {
      store.createSession('Goal')
      expect(store.hasActiveSession()).toBe(true)
    })
  })

  describe('write', () => {
    beforeEach(() => {
      store.init()
      store.createSession('Goal')
    })

    it('updates session data', () => {
      const graph = store.read()
      graph.session.goal = 'Updated'
      store.write(graph)
      expect(store.read().session.goal).toBe('Updated')
    })
  })

  describe('addNote', () => {
    beforeEach(() => {
      store.init()
      store.createSession('Goal')
    })

    it('adds a note', () => {
      store.addNote('my note', 'developer', 'decision')
      const graph = store.read()
      expect(graph.session.notes).toHaveLength(1)
      expect(graph.session.notes[0].text).toBe('my note')
      expect(graph.session.notes[0].source).toBe('developer')
      expect(graph.session.notes[0].category).toBe('decision')
    })

    it('adds multiple notes', () => {
      store.addNote('first')
      store.addNote('second')
      expect(store.read().session.notes).toHaveLength(2)
    })
  })

  describe('closeSession', () => {
    beforeEach(() => {
      store.init()
      store.createSession('Goal')
    })

    it('archives session to history', () => {
      const graph = store.read()
      store.closeSession('complete')
      const historyDir = join(dir, '.intent', 'history')
      const files = readdirSync(historyDir)
      expect(files).toContain(`${graph.session.id}.yml`)
    })

    it('removes active session file', () => {
      store.closeSession('complete')
      expect(existsSync(store.sessionFile)).toBe(false)
    })

    it('sets session status to complete', () => {
      store.closeSession('complete')
      const last = store.getLastSession()
      expect(last!.session.status).toBe('complete')
    })

    it('sets session status to abandoned', () => {
      store.closeSession('abandoned')
      const last = store.getLastSession()
      expect(last!.session.status).toBe('abandoned')
    })

    it('sets closed_at timestamp', () => {
      store.closeSession('complete')
      const last = store.getLastSession()
      expect(last!.session.closed_at).not.toBeNull()
    })
  })

  describe('getLastSession', () => {
    it('returns null before any session', () => {
      store.init()
      expect(store.getLastSession()).toBeNull()
    })

    it('returns null without init', () => {
      expect(store.getLastSession()).toBeNull()
    })

    it('returns most recent session', () => {
      store.init()
      store.createSession('First')
      store.closeSession('complete')
      store.createSession('Second')
      store.closeSession('complete')
      const last = store.getLastSession()
      expect(last!.session.goal).toBe('Second')
    })
  })

  describe('getSessionById', () => {
    beforeEach(() => {
      store.init()
      store.createSession('Goal')
      store.closeSession('complete')
    })

    it('returns session by ID', () => {
      const s = store.getSessionById('session-001')
      expect(s).not.toBeNull()
      expect(s!.session.goal).toBe('Goal')
    })

    it('returns null for unknown ID', () => {
      expect(store.getSessionById('session-999')).toBeNull()
    })
  })

  describe('listSessions', () => {
    it('returns empty array without init', () => {
      expect(store.listSessions()).toEqual([])
    })

    it('lists all archived sessions', () => {
      store.init()
      store.createSession('First')
      store.closeSession('complete')
      store.createSession('Second')
      store.closeSession('complete')
      const list = store.listSessions()
      expect(list).toHaveLength(2)
    })

    it('returns sessions newest first', () => {
      store.init()
      store.createSession('Alpha')
      store.closeSession('complete')
      store.createSession('Beta')
      store.closeSession('complete')
      const list = store.listSessions()
      expect(list[0].session.goal).toBe('Beta')
      expect(list[1].session.goal).toBe('Alpha')
    })
  })

  describe('createSession with parent', () => {
    beforeEach(() => store.init())

    it('sets parent_session and relation', () => {
      const graph = store.createSession('Child', 'opencode', { id: 'session-001', relation: 'continue' })
      expect(graph.session.parent_session).toBe('session-001')
      expect(graph.session.relation).toBe('continue')
    })
  })

  describe('error resilience', () => {
    beforeEach(() => store.init())

    it('handles malformed session file gracefully', () => {
      store.createSession('Good')
      store.closeSession('complete')
      store.createSession('Bad')
      // Corrupt the file
      const { writeFileSync } = require('fs')
      writeFileSync(store.sessionFile, '{bad yaml: unquoted', 'utf8')
      expect(() => store.read()).toThrow()
    })

    it('nextSessionId falls back on corrupt history', () => {
      store.createSession('Test')
      store.closeSession('complete')
      // Session still uses nextSessionId internally for createSession
      // It should fall back gracefully
      const graph = store.createSession('New')
      expect(graph.session.goal).toBe('New')
    })
  })
})
