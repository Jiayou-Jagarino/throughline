#!/usr/bin/env node
// E2E test: spawns mock agent, pipes through MarkerScanner, verifies detection
import { execSync } from 'child_process'
import { join, dirname } from 'path'
import { fileURLToPath, pathToFileURL } from 'url'
import { mkdtempSync, rmSync, existsSync } from 'fs'
import { tmpdir } from 'os'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const MOCK_AGENT = join(ROOT, 'scripts', 'mock-agent.mjs')
const TL = join(ROOT, 'dist', 'index.js')

const dir = mkdtempSync(join(tmpdir(), 'tl-e2e-mock-'))
const PASS = '\x1b[32mPASS\x1b[0m'
const FAIL = '\x1b[31mFAIL\x1b[0m'

let passed = 0
let failed = 0
let errors = []

function check(label, ok) {
  if (ok) { passed++; console.log(`  ${PASS} ${label}`) }
  else { failed++; console.log(`  ${FAIL} ${label}`) }
}

try {
  // 1. Initialize
  execSync(`node "${TL}" init --cwd "${dir}"`, { encoding: 'utf8', timeout: 15000 })
  execSync(`node "${TL}" start "E2E mock agent test" --setup --cwd "${dir}"`, { encoding: 'utf8', timeout: 15000 })
  check('Session created', true)

  // 2. Run mock agent and capture stdout
  const output = execSync(`node "${MOCK_AGENT}"`, { encoding: 'utf8', timeout: 15000 })
  check('Mock agent produced output', output.length > 0)
  check('Contains PLAN marker', output.includes('[THROUGHLINE:PLAN]'))
  check('Contains STEP_DONE marker', output.includes('[THROUGHLINE:STEP_DONE]'))
  check('Contains NOTE marker', output.includes('[THROUGHLINE:NOTE'))
  check('Contains CONTEXT_READ marker', output.includes('[THROUGHLINE:CONTEXT_READ]'))

  // 3. Strip markers to verify clean output
  const { stripMarkers } = await import(pathToFileURL(join(ROOT, 'dist', 'parsers', 'deviationParser.js')).href)
  const stripped = stripMarkers(output)
  check('Markers stripped cleanly', !stripped.includes('THROUGHLINE'))
  check('Context.txt exists', existsSync(join(dir, '.intent', 'context.txt')))

} catch (err) {
  errors.push(err.message)
  console.log(`  ${FAIL} Error: ${err.message}`)
} finally {
  try { rmSync(dir, { recursive: true, force: true }) } catch {}
}

const total = passed + failed
console.log(`\n\x1b[1m═══ Results: ${passed}/${total} passed, ${failed} failed ═══\x1b[0m`)
if (failed > 0 || errors.length > 0) process.exit(1)

