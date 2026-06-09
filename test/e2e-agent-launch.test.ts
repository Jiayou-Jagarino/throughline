import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execSync } from 'child_process'
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync } from 'fs'
import { join, dirname } from 'path'
import { tmpdir } from 'os'
import { fileURLToPath } from 'url'
import { load } from 'js-yaml'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const ROOT = join(__dirname, '..')
const TL = join(ROOT, 'dist', 'index.js')
const MOCK_AGENT = join(ROOT, 'scripts', 'mock-agent.mjs')

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'tl-e2e-launch-'))
}

function tl(args: string, cwd: string, env?: Record<string, string>): string {
  return execSync(`node "${TL}" ${args}`, { cwd, encoding: 'utf8', timeout: 30000, env: { ...process.env, ...env } as any })
}

describe('E2E: agent launch pipeline', () => {
  let dir: string

  beforeEach(() => {
    dir = tmpDir()
  })

  afterEach(() => {
    try { rmSync(dir, { recursive: true, force: true }) } catch {}
  })

  it('spawns agent via launchAgent, processes all stdout markers, updates session.yml', () => {
    // 1. Initialize
    tl('init', dir)

    // 2. Start a session with the mock agent via THROUGHLINE_AGENT_BIN
    //    The mock agent outputs PLAN, STEP_DONE, NOTE, and CONTEXT_READ markers then exits.
    //    Throughline's launchAgent should parse these markers, update session.yml,
    //    and auto-close the session.
    const env = { THROUGHLINE_AGENT_BIN: `node ${MOCK_AGENT}` }
    const out = tl(`start "E2E agent launch test" --agent other --cwd "${dir}"`, dir, env)

    // 3. Verify session was auto-closed (session.yml archived to history)
    const sessionFile = join(dir, '.intent', 'session.yml')
    expect(existsSync(sessionFile)).toBe(false)

    const historyDir = join(dir, '.intent', 'history')
    expect(existsSync(historyDir)).toBe(true)

    const historyFiles = readdirSync(historyDir).filter((f: string) => f.endsWith('.yml'))
    expect(historyFiles.length).toBeGreaterThan(0)

    // 4. Read the archived session
    const archived = load(readFileSync(join(historyDir, historyFiles[0]), 'utf8')) as any

    // PLAN marker → tasks were added to session.yml
    expect(archived.tasks).toBeDefined()
    expect(archived.tasks.length).toBe(1)
    expect(archived.tasks[0].intent).toBe('Mock task')
    expect(archived.tasks[0].steps.length).toBe(1)
    expect(archived.tasks[0].steps[0].intent).toBe('Mock step')

    // STEP_DONE marker → step was completed
    expect(archived.tasks[0].steps[0].status).toBe('complete')

    // NOTE marker → note was added to session
    expect(archived.session.notes).toBeDefined()
    expect(archived.session.notes.length).toBe(1)
    expect(archived.session.notes[0].text).toBe('test note from agent')

    // Session was auto-closed as complete (all tasks done after step completion)
    expect(archived.session.status).toBe('complete')

    // 5. Verify context.txt exists
    expect(existsSync(join(dir, '.intent', 'context.txt'))).toBe(true)

    // 6. Verify audit log recorded the CONTEXT_READ marker
    const audit = readFileSync(join(dir, '.intent', 'context-audit.log'), 'utf8')
    expect(audit).toContain('source=agent')
  })
})
