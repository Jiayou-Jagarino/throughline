import { spawn } from 'node-pty'
import { writeFileSync, readFileSync } from 'fs'

const dir = process.cwd()
const outFile = 'C:\\Users\\Thinkpad\\AppData\\Local\\Temp\\opencode\\stdin-test2.txt'

const inner = spawn('node.exe', ['-e', `
  const fs = require("fs");
  const f = process.env.STDIN_FILE;
  let d = "";
  process.stdin.on("data", c => d += c);
  setTimeout(() => { fs.writeFileSync(f, d); process.exit(0); }, 2000);
`], {
  name: 'xterm', cols: 120, rows: 30, cwd: dir,
  env: { STDIN_FILE: outFile },
})

// Forward this process's stdin
process.stdin.setRawMode(true)
process.stdin.on('data', data => inner.write(data.toString()))
process.stdin.resume()

setTimeout(() => {
  inner.write('hello from TTY!')
}, 500)

setTimeout(() => {
  const r = readFileSync(outFile, 'utf8')
  console.log('Received:', JSON.stringify(r))
  process.exit(0)
}, 4000)
