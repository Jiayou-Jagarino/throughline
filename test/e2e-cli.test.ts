import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execSync } from 'child_process'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { tmpdir } from 'os'
import { fileURLToPath } from 'url'
import { load, dump } from 'js-yaml'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const TL = join(__dirname, '..', 'dist', 'index.js')

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'tl-cli-'))
}

function tl(args: string, cwd: string): string {
  return execSync(`node "${TL}" ${args}`, { cwd, encoding: 'utf8', timeout: 15000 })
}

describe('E2E: CLI commands', () => {
  let dir: string

  beforeEach(() => {
    dir = tmpDir()
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('init creates .intent directory', () => {
    const out = tl('init', dir)
    expect(out).toContain('Throughline initialized')
    expect(existsSync(join(dir, '.intent'))).toBe(true)
  })

  it('init --force reinitializes', () => {
    tl('init', dir)
    const out2 = tl('init --force', dir)
    expect(out2).toContain('Reinitializing')
  })

  it('start --setup creates session', () => {
    tl('init', dir)
    const out = tl('start "Test goal" --setup', dir)
    expect(out).toContain('Session started')
    expect(out).toContain('Test goal')
    expect(existsSync(join(dir, '.intent', 'session.yml'))).toBe(true)
  })

  it('status shows session info', () => {
    tl('init', dir)
    tl('start "Status test" --setup', dir)
    const out = tl('status', dir)
    expect(out).toContain('Status test')
    expect(out).toContain('pending')
  })

  it('status --json outputs valid JSON', () => {
    tl('init', dir)
    tl('start "JSON test" --setup', dir)
    const out = tl('status --json', dir)
    const parsed = JSON.parse(out)
    expect(parsed.session.goal).toBe('JSON test')
    expect(parsed.session.status).toBe('pending')
  })

  it('full lifecycle: start → status → done → history', () => {
    // Init + start
    tl('init', dir)
    tl('start "Lifecycle" --setup', dir)

    // Simulate a plan by writing a task to session.yml
    const sessionFile = join(dir, '.intent', 'session.yml')
    const yaml = load(readFileSync(sessionFile, 'utf8')) as any
    yaml.tasks = [{
      id: 't1',
      intent: 'Lifecycle task',
      declared_by: 'ai',
      status: 'in_progress',
      depends_on: [],
      steps: [{
        id: 't1-s1',
        intent: 'Lifecycle step',
        declared_by: 'ai',
        status: 'in_progress',
        files: { planned: ['test.txt'], touched: [] },
        deviation: null,
        completed_at: null,
      }],
    }]
    writeFileSync(sessionFile, dump(yaml, { lineWidth: 120 }), 'utf8')

    // Write context file to pick up changes
    const helper = join(__dirname, '..', 'scripts', 'ctx-helper.mjs')
    execSync(`node "${helper}" "${dir}" "test"`, { cwd: join(__dirname, '..'), encoding: 'utf8' })

    // Status should show the task
    const statusOut = tl('status', dir)
    expect(statusOut).toContain('Lifecycle task')

    // Complete step
    const doneOut = tl('done', dir)
    expect(doneOut).toContain('Step complete')

    // Close session
    const closeOut = tl('done --session', dir)
    expect(closeOut).toContain('Session complete')

    // History should show it
    const histOut = tl('history', dir)
    expect(histOut).toContain('Lifecycle')
    expect(histOut).toContain('session-001')
  })

  it('deviate records a deviation', () => {
    tl('init', dir)
    tl('start "Deviate test" --setup', dir)

    // Add an in-progress task
    const sessionFile = join(dir, '.intent', 'session.yml')
    const yaml = load(readFileSync(sessionFile, 'utf8')) as any
    yaml.session.status = 'in_progress'
    yaml.tasks = [{
      id: 't1',
      intent: 'Do something',
      declared_by: 'ai',
      status: 'in_progress',
      depends_on: [],
      steps: [{
        id: 't1-s1',
        intent: 'Do step',
        declared_by: 'ai',
        status: 'in_progress',
        files: { planned: ['x.ts'], touched: [] },
        deviation: null,
        completed_at: null,
      }],
    }]
    writeFileSync(sessionFile, dump(yaml, { lineWidth: 120 }), 'utf8')

    const out = tl('deviate "API changed" --spawns "Update API calls"', dir)
    expect(out).toContain('Deviation recorded')
  })

  it('note records a note', () => {
    tl('init', dir)
    tl('start "Note test" --setup', dir)

    const out = tl('note "test decision" --category decision', dir)
    expect(out).toContain('Note recorded')
  })

  it('history --json outputs valid JSON', () => {
    tl('init', dir)
    tl('start "History JSON" --setup', dir)
    tl('done --session', dir)

    const out = tl('history --json', dir)
    const parsed = JSON.parse(out)
    expect(Array.isArray(parsed)).toBe(true)
    expect(parsed[0].session.goal).toBe('History JSON')
  })

  it('history -n limits results', () => {
    tl('init', dir)
    // Create 3 sessions
    for (let i = 0; i < 3; i++) {
      tl(`start "Session ${i}" --setup`, dir)
      tl('done --session', dir)
    }

    const full = tl('history', dir)
    expect(full).toContain('3 sessions')

    const limited = tl('history -n 1', dir)
    expect(limited).toContain('1 of 3 sessions')
    expect(limited).toContain('session-003')
    expect(limited).not.toContain('session-002')
  })

  it('cwd option works', () => {
    // Init with --cwd should create .intent in that directory
    tl(`init --cwd "${dir}"`, dir)
    expect(existsSync(join(dir, '.intent'))).toBe(true)
  })
})
