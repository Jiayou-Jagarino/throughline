#!/usr/bin/env node
import { execSync } from 'child_process'
import { existsSync, readFileSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const ROOT = 'D:\\throughline'
const TL = ROOT + '\\dist\\index.js'
const HELPER = ROOT + '\\scripts\\ctx-helper.mjs'
const PASS = '\x1b[32mPASS\x1b[0m'
const FAIL = '\x1b[31mFAIL\x1b[0m'
const BOLD = '\x1b[1m'
const RESET = '\x1b[0m'

let passed = 0
let failed = 0

function testDir(name) {
  const d = join(tmpdir(), 'tl-ctx-' + name + '-' + Date.now())
  mkdirSync(d, { recursive: true })
  return d
}

function tl(args, cwd) {
  return execSync(`node "${TL}" ${args}`, { cwd, encoding: 'utf8', timeout: 15000, stdio: 'pipe' })
}

function exists(p) { return existsSync(p) }
function readFile(p) { try { return readFileSync(p, 'utf8') } catch { return null } }

function check(label, condition, detail = '') {
  if (condition) { passed++; console.log(`  ${PASS} ${label}`) }
  else { failed++; console.log(`  ${FAIL} ${label} ${detail}`) }
}

// Run JS code as ESM via helper
// Evaluate JS as ESM from the throughline root (so node_modules resolves)
function nodeEval(code) {
  const f = join(ROOT, '_eval-' + Date.now() + '.mjs')
  writeFileSync(f, code, 'utf8')
  const r = execSync(`node "${f}"`, { cwd: ROOT, encoding: 'utf8', timeout: 15000, stdio: 'pipe' })
  try { rmSync(f) } catch {}
  return r
}

// Write context.txt via the same code path markers use
function writeCtx(cwd, trigger = 'test') {
  return execSync(`node "${HELPER}" "${cwd}" "${trigger}"`, { cwd: ROOT, encoding: 'utf8', timeout: 15000, stdio: 'pipe' })
}

// Modify session.yml in the test directory
function setSessionYml(cwd, modifier) {
  const sf = join(cwd, '.intent', 'session.yml')
  nodeEval(`
    import { load, dump } from 'js-yaml';
    import { readFileSync, writeFileSync } from 'fs';
    const g = load(readFileSync(${JSON.stringify(sf)}, 'utf8'));
    ${modifier}
    writeFileSync(${JSON.stringify(sf)}, dump(g, { lineWidth: 120 }), 'utf8');
  `)
}

console.log(BOLD + '\n═══ Throughline Context File: Exhaustive Test ═══\n' + RESET)

// ─── 1. Not initialized → no file ───────────────────────────────────────────
;(() => {
  const d = testDir('noinit')
  const out = tl('status', d)
  check('1.1 status shows not initialized', out.includes('Not initialized'))
  check('1.2 no context.txt without .intent', !exists(join(d, '.intent', 'context.txt')))
  check('1.3 no audit log without .intent', !exists(join(d, '.intent', 'context-audit.log')))
})()

// ─── 2. Init only, no session → no file ────────────────────────────────────
;(() => {
  const d = testDir('initonly')
  tl('init', d)
  check('2.1 .intent/ exists', exists(join(d, '.intent')))
  check('2.2 no context.txt before session', !exists(join(d, '.intent', 'context.txt')))
})()

// ─── 3. Start session → context.txt created ────────────────────────────────
;(() => {
  const d = testDir('start')
  tl('init', d)
  tl('start "Refactor auth" --agent opencode --setup', d)

  const fp = join(d, '.intent', 'context.txt')
  check('3.1 context.txt exists', exists(fp))
  const content = readFile(fp)
  check('3.2 has [THROUGHLINE CONTEXT] tags', content.includes('[THROUGHLINE CONTEXT]') && content.includes('[/THROUGHLINE CONTEXT]'))
  check('3.3 has goal', content.includes('Refactor auth'))
  check('3.4 no dashed separator leak', !content.includes('───'), 'buildContextBlock output should not contain terminal dashes')
  check('3.5 status is pending', content.includes('Status: pending'))
  check('3.6 does not contain "undefined"', !content.includes('undefined'))

  const audit = readFile(join(d, '.intent', 'context-audit.log'))
  check('3.7 audit log exists', audit && audit.length > 0)
  check('3.8 audit has session-start trigger', audit.includes('trigger=session-start'))
  check('3.9 audit has size=N', /\bsize=\d+/.test(audit))
})()

// ─── 4. Plan captured → context file updates ──────────────────────────────
;(() => {
  const d = testDir('plan')
  tl('init', d)
  tl('start "Add login" --agent opencode --setup', d)

  setSessionYml(d, `
    g.session.status = 'in_progress';
    g.tasks = [{ id:'t1', intent:'Add login form', declared_by:'ai', status:'in_progress', depends_on:[], steps:[{ id:'t1-s1', intent:'Create LoginPage', declared_by:'ai', status:'in_progress', files:{planned:['src/LoginPage.tsx'],touched:[]}, deviation:null, completed_at:null }] }];
  `)

  writeCtx(d, 'test-plan')

  const ctx = readFile(join(d, '.intent', 'context.txt'))
  check('4.1 context updated after plan', ctx.includes('Add login form'))
  check('4.2 plan reflected as in_progress', ctx.includes('in_progress'))
  check('4.3 includes step', ctx.includes('Create LoginPage'))
  check('4.4 includes planned file', ctx.includes('src/LoginPage.tsx'))

  const audit = readFile(join(d, '.intent', 'context-audit.log'))
  check('4.5 audit has test-plan trigger', audit.includes('trigger=test-plan'))
})()

// ─── 5. Step done → context advances ──────────────────────────────────────
;(() => {
  const d = testDir('stepdone')
  tl('init', d)
  tl('start "Fix bug" --agent opencode --setup', d)

  setSessionYml(d, `
    g.session.status = 'in_progress';
    g.tasks = [{ id:'t1', intent:'Fix the bug', declared_by:'ai', status:'in_progress', depends_on:[], steps:[
      { id:'t1-s1', intent:'Find root cause', declared_by:'ai', status:'complete', files:{planned:[],touched:[]}, deviation:null, completed_at:'2026-06-09T10:00:00Z' },
      { id:'t1-s2', intent:'Apply fix', declared_by:'ai', status:'in_progress', files:{planned:['src/bug.ts'],touched:[]}, deviation:null, completed_at:null },
      { id:'t1-s3', intent:'Verify fix', declared_by:'ai', status:'pending', files:{planned:[],touched:[]}, deviation:null, completed_at:null },
    ] }];
  `)

  writeCtx(d, 'test-stepdone')

  const ctx = readFile(join(d, '.intent', 'context.txt'))
  check('5.1 shows completed step', ctx.includes('✓ Find root cause'))
  check('5.2 shows current step (Apply fix)', /Apply fix/.test(ctx))
  check('5.3 shows pending step (Verify fix)', ctx.includes('Verify fix'))
  check('5.4 completed step listed first', ctx.indexOf('✓ Find root cause') < ctx.indexOf('Apply fix'))
})()

// ─── 6. Deviation → context shows deviation ────────────────────────────────
;(() => {
  const d = testDir('deviate')
  tl('init', d)
  tl('start "Build feature" --agent opencode --setup', d)

  setSessionYml(d, `
    g.session.status = 'in_progress';
    g.tasks = [{ id:'t1', intent:'Build the feature', declared_by:'ai', status:'deviated', depends_on:[], steps:[{ id:'t1-s1', intent:'Implement core', declared_by:'ai', status:'deviated', files:{planned:['src/core.ts'],touched:['src/core.ts']}, deviation:{reason:'API changed, need new approach',spawned_task:'t2',recorded_at:'2026-06-09T10:00:00Z'}, completed_at:null }] }];
  `)

  writeCtx(d, 'test-deviate')

  const ctx = readFile(join(d, '.intent', 'context.txt'))
  check('6.1 context contains deviation count', ctx.includes('Deviations recorded'))
  check('6.2 context shows task as deviated', ctx.includes('deviated') || ctx.includes('Deviations'))
})()

// ─── 7. Note → context shows note ─────────────────────────────────────────
;(() => {
  const d = testDir('note')
  tl('init', d)
  tl('start "Refactor" --agent opencode --setup', d)
  tl('note "Use Zustand for state management" --category decision', d)

  const ctx = readFile(join(d, '.intent', 'context.txt'))
  check('7.1 context contains note', ctx.includes('Zustand'))
  check('7.2 context has Session notes section', ctx.includes('Session notes'))
})()

// ─── 8. Multiple writes → file overwrites correctly ────────────────────────
;(() => {
  const d = testDir('overwrite')
  tl('init', d)
  tl('start "Multi step" --agent opencode --setup', d)

  writeCtx(d, 'write-one')
  writeCtx(d, 'write-two')

  const audit = readFile(join(d, '.intent', 'context-audit.log'))
  const auditLines = audit.trim().split('\n')
  check('8.1 audit has 2+ entries', auditLines.length >= 2)
  check('8.2 first write tagged', auditLines.some(l => l.includes('write-one')))
  check('8.3 second write tagged', auditLines.some(l => l.includes('write-two')))
  check('8.4 context.txt has exact one block', readFile(join(d, '.intent', 'context.txt')).split('[THROUGHLINE CONTEXT]').length === 2)
})()

// ─── 9. No duplicate context in file ──────────────────────────────────────
;(() => {
  const d = testDir('dedup')
  tl('init', d)
  tl('start "Test" --agent opencode --setup', d)

  writeCtx(d, 'dedup-1')
  writeCtx(d, 'dedup-2')
  writeCtx(d, 'dedup-3')

  const ctx = readFile(join(d, '.intent', 'context.txt'))
  const opens = ctx.split('[THROUGHLINE CONTEXT]').length - 1
  const closes = ctx.split('[/THROUGHLINE CONTEXT]').length - 1
  check('9.1 exactly one [THROUGHLINE CONTEXT]', opens === 1)
  check('9.2 exactly one [/THROUGHLINE CONTEXT]', closes === 1)
  check('9.3 no concatenation artifacts', !ctx.includes('[THROUGHLINE CONTEXT][THROUGHLINE CONTEXT]'))
})()

// ─── 10. File size sanity ─────────────────────────────────────────────────
;(() => {
  const d = testDir('sanity')
  tl('init', d)
  tl('start "Performance optimization" --agent opencode --setup', d)

  writeCtx(d, 'sanity-check')

  const ctx = readFile(join(d, '.intent', 'context.txt'))
  check('10.1 context file under 10KB', ctx.length < 10000)
  check('10.2 context file not empty', ctx.length > 30)
})()

// ─── SUMMARY ────────────────────────────────────────────────────────────────
const total = passed + failed
console.log(`\n${BOLD}═══ Results: ${passed}/${total} passed, ${failed} failed ═══${RESET}`)
if (failed > 0) process.exit(1)
