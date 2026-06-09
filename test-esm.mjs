// Simulate the resolve function in ESM context
import { execSync } from 'child_process'
import { readFileSync, existsSync } from 'fs'

function resolveWin32Exe(name) {
  try {
    const output = execSync(`where ${name}`, { encoding: 'utf8', shell: 'cmd.exe' }).trim()
    const paths = output.split('\n').map(s => s.trim()).filter(Boolean)
    const cmdShim = paths.find(p => /\.cmd$/i.test(p) || /\.bat$/i.test(p))
    if (cmdShim) {
      const content = readFileSync(cmdShim, 'utf8')
      const match = content.match(/"([^"]+\.exe)"/)
      if (match) {
        let exePath = match[1]
        if (exePath.includes('%dp0%')) {
          const shimDir = cmdShim.replace(/[/\\][^/\\]*$/, '')
          exePath = exePath.replace(/%dp0%/ig, shimDir)
        }
        if (existsSync(exePath)) return exePath
      }
    }
    return name
  } catch (e) {
    console.error('resolve error:', e?.message || e)
    return name
  }
}

const resolved = resolveWin32Exe('opencode')
console.log('resolved:', resolved)

// Now try using it with pty
import pty from 'node-pty'
const p = pty.spawn(resolved, ['--version'], {
  name: 'xterm-256color',
  cols: 80, rows: 24,
  env: { ...process.env, FORCE_COLOR: '1' }
})
let out = ''
p.onData(d => { out += d })
setTimeout(() => {
  console.log('pty output:', JSON.stringify(out.slice(0, 200)))
  p.kill()
  process.exit(0)
}, 5000)
