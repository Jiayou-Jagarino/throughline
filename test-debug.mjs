import { execSync } from 'child_process'
import { readFileSync, existsSync } from 'fs'

try {
  const output = execSync('where opencode', { encoding: 'utf8', shell: 'cmd.exe' }).trim()
  console.log('where output:', JSON.stringify(output))

  const paths = output.split('\n').map(s => s.trim()).filter(Boolean)
  console.log('paths:', paths)

  const cmdShim = paths.find(p => /\.cmd$/i.test(p) || /\.bat$/i.test(p))
  console.log('cmdShim found:', cmdShim)

  if (cmdShim) {
    const content = readFileSync(cmdShim, 'utf8')
    console.log('shim content:', JSON.stringify(content))
    const match = content.match(/"([^"]+\.exe)"/)
    console.log('regex match:', match ? match[1] : 'no match')

    if (match) {
      let exePath = match[1]
      if (exePath.includes('%dp0%')) {
        const shimDir = cmdShim.replace(/[/\\][^/\\]*$/, '')
        exePath = exePath.replace(/%dp0%/ig, shimDir)
      }
      console.log('resolved exe:', exePath)
      console.log('exists:', existsSync(exePath))
    }
  }
} catch (e) {
  console.log('error:', e.message)
}
