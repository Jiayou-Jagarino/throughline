import chalk from 'chalk'
import chokidar from 'chokidar'
import readline from 'readline'
import { execSync } from 'child_process'
import { existsSync, readFileSync } from 'fs'
import { SessionStore } from '../engine/SessionStore.js'
import { TaskTracker } from '../engine/TaskTracker.js'
import { ContextBuilder } from '../engine/ContextBuilder.js'
import { FileWatcher } from '../engine/FileWatcher.js'
import { PtySession } from '../session/PtySession.js'
import { MarkerScanner } from '../session/MarkerScanner.js'
import { buildAgentSystemPrompt } from '../parsers/deviationParser.js'
import type { Agent } from '../types.js'

// ─── init ─────────────────────────────────────────────────────────────────

export function cmdInit(options: { cwd?: string } = {}) {
  const store = new SessionStore(options.cwd)

  if (store.isInitialized()) {
    console.log(chalk.yellow('⚠  .intent/ already exists in this directory'))
    return
  }

  store.init()
  console.log(chalk.green('✓ Throughline initialized'))
  console.log(chalk.dim('  Created .intent/ directory'))
  console.log(chalk.dim('  Added session.yml to .gitignore'))
  console.log(chalk.dim('  Spec available at .intent/spec.md'))
  console.log()
  console.log(chalk.white('Start a session:'))
  console.log(chalk.cyan('  throughline start "your goal here"'))
}

// ─── start ────────────────────────────────────────────────────────────────

export async function cmdStart(goal: string, options: { agent?: string; setup?: boolean; cwd?: string } = {}) {
  const store = new SessionStore(options.cwd)
  const tracker = new TaskTracker(store)
  const contextBuilder = new ContextBuilder(store)

  if (!store.isInitialized()) {
    console.log(chalk.yellow('Run `throughline init` first'))
    return
  }

  if (store.hasActiveSession()) {
    const graph = store.read()
    console.log(chalk.yellow(`⚠  Active session exists: "${graph.session.goal}"`))
    console.log(chalk.dim('  Run `throughline status` to see it, or `throughline done --session` to close it'))
    return
  }

  const agent = (options.agent as Agent) || detectAgent()
  const graph = store.createSession(goal, agent)

  console.log(chalk.green('✓ Session started'))
  console.log(chalk.white(`  Goal: ${chalk.bold(goal)}`))
  console.log(chalk.white(`  Agent: ${agent}`))
  console.log(chalk.white(`  ID: ${graph.session.id}`))
  console.log()

  contextBuilder.writeContextFile('session-start')

  if (options.setup) {
    console.log(chalk.dim('Session created without launching agent.'))
    console.log(chalk.dim('Run `throughline attach` in another terminal to monitor.'))
    console.log()
    const contextBlock = contextBuilder.buildContextBlock()
    console.log(chalk.cyan('─── THROUGHLINE CONTEXT ───'))
    process.stdout.write(contextBlock + '\n')
    console.log(chalk.cyan('───────────────────────────'))
    console.log()
    return
  }

  // Build context block for injection
  const contextBlock = contextBuilder.buildContextBlock()
  const systemPrompt = buildAgentSystemPrompt(contextBlock)

  // Start the agent with intent context injected
  await launchAgent(agent, goal, systemPrompt, store, tracker, contextBuilder)
}

// ─── status ───────────────────────────────────────────────────────────────

export function cmdStatus(options: { cwd?: string } = {}) {
  const store = new SessionStore(options.cwd)

  if (!store.isInitialized()) {
    console.log(chalk.yellow('Not initialized. Run `throughline init`'))
    return
  }

  if (!store.hasActiveSession()) {
    console.log(chalk.dim('No active session'))
    return
  }

  const graph = store.read()
  const { session, tasks } = graph

  // Header
  const statusColor = {
    pending: chalk.yellow,
    in_progress: chalk.blue,
    complete: chalk.green,
    abandoned: chalk.red,
    deviated: chalk.magenta,
  }[session.status] || chalk.white

  console.log()
  console.log(chalk.bold('SESSION') + '  ' + statusColor(`● ${session.status}`))
  console.log(chalk.white(`Goal: ${chalk.bold(session.goal)}`))
  console.log(chalk.dim(`ID: ${session.id}  Agent: ${session.agent}  Started: ${new Date(session.started_at).toLocaleString()}`))
  console.log()

  if (tasks.length === 0) {
    console.log(chalk.dim('  No tasks planned yet'))
    return
  }

  // Tasks tree
  for (const task of tasks) {
    const icon = { complete: '✓', in_progress: '▶', pending: '·', abandoned: '✗', deviated: '⚡' }[task.status] || '·'
    const color = statusColor
    const tColor = {
      complete: chalk.green,
      in_progress: chalk.blue,
      pending: chalk.dim,
      abandoned: chalk.red,
      deviated: chalk.magenta,
    }[task.status] || chalk.white

    console.log(tColor(`  ${icon} [${task.id}] ${task.intent}`))

    for (const step of task.steps) {
      const sIcon = { complete: '✓', in_progress: '▶', pending: '·', abandoned: '✗', deviated: '⚡' }[step.status] || '·'
      const sColor = {
        complete: chalk.green,
        in_progress: chalk.blue,
        pending: chalk.dim,
        abandoned: chalk.red,
        deviated: chalk.magenta,
      }[step.status] || chalk.dim

      console.log(sColor(`      ${sIcon} [${step.id}] ${step.intent}`))

      if (step.files.touched.length > 0) {
        console.log(chalk.dim(`          touched: ${step.files.touched.join(', ')}`))
      }

      if (step.deviation) {
        console.log(chalk.magenta(`          ⚡ deviation: ${step.deviation.reason}`))
        if (step.deviation.spawned_task) {
          console.log(chalk.magenta(`             → spawned ${step.deviation.spawned_task}`))
        }
      }
    }
  }

  // Summary
  const completed = tasks.filter(t => t.status === 'complete').length
  const deviations = tasks.flatMap(t => t.steps.filter(s => s.deviation)).length
  console.log()
  console.log(chalk.dim(`  ${completed}/${tasks.length} tasks complete  ${deviations} deviations recorded`))
  console.log()
}

// ─── deviate ──────────────────────────────────────────────────────────────

export function cmdDeviate(reason: string, options: { spawns?: string; cwd?: string } = {}) {
  const store = new SessionStore(options.cwd)
  const tracker = new TaskTracker(store)

  if (!store.hasActiveSession()) {
    console.log(chalk.yellow('No active session'))
    return
  }

  const currentTask = tracker.getCurrentTask()
  const currentStep = tracker.getCurrentStep()

  if (!currentTask || !currentStep) {
    console.log(chalk.yellow('No in-progress step to deviate from'))
    console.log(chalk.dim('Use `throughline status` to see current state'))
    return
  }

  tracker.recordDeviation(currentTask.id, currentStep.id, {
    reason,
    spawned_task: options.spawns || null,
    recorded_at: new Date().toISOString(),
  })

  const ctxBuilder = new ContextBuilder(store)
  ctxBuilder.writeContextFile('cmd-deviate')

  console.log(chalk.magenta('⚡ Deviation recorded'))
  console.log(chalk.white(`  Reason: ${reason}`))
  if (options.spawns) {
    console.log(chalk.white(`  Spawned new task: "${options.spawns}"`))
  }
  console.log(chalk.dim('  Run `throughline status` to see updated intent graph'))
}

// ─── done ─────────────────────────────────────────────────────────────────

export function cmdDone(options: { session?: boolean; abandon?: boolean; cwd?: string } = {}) {
  const store = new SessionStore(options.cwd)
  const tracker = new TaskTracker(store)

  if (!store.hasActiveSession()) {
    console.log(chalk.yellow('No active session'))
    return
  }

  if (options.session) {
    const graph = store.read()
    const status = options.abandon ? 'abandoned' : 'complete'

    const ctxB = new ContextBuilder(store)
    ctxB.writeContextFile('cmd-done-session')
    ctxB.stopReadWatcher()

    // ── Build summary ──
    const totalTasks = graph.tasks.length
    const completedTasks = graph.tasks.filter(t => t.status === 'complete').length
    const abandonedTasks = graph.tasks.filter(t => t.status === 'abandoned').length
    const deviatedTasks = graph.tasks.filter(t => t.status === 'deviated').length
    const deviations = graph.tasks.flatMap(t => t.steps.filter(s => s.deviation))
    const allTouched = [...new Set(graph.tasks.flatMap(t => t.steps.flatMap(s => s.files.touched)))]
    const allPlanned = [...new Set(graph.tasks.flatMap(t => t.steps.flatMap(s => s.files.planned)))]
    const unplanned = allTouched.filter(f => !allPlanned.some(p => f.includes(p) || p.includes(f)))
    const notes = graph.session.notes
    const duration = graph.session.started_at
      ? Math.round((Date.now() - new Date(graph.session.started_at).getTime()) / 60000)
      : 0

    store.closeSession(status)

    console.log()
    console.log(status === 'complete' ? chalk.green('── Session complete ──') : chalk.red('── Session abandoned ──'))
    console.log()
    if (graph.session.goal) console.log(chalk.white(`  Goal: ${chalk.bold(graph.session.goal)}`))
    console.log(chalk.dim(`  ${graph.session.id}  ·  ${graph.session.agent}  ·  ${duration}m`))
    console.log()

    if (totalTasks > 0) {
      const taskLine = []
      if (completedTasks > 0) taskLine.push(chalk.green(`✓ ${completedTasks} complete`))
      if (deviatedTasks > 0) taskLine.push(chalk.magenta(`⚡ ${deviatedTasks} deviated`))
      if (abandonedTasks > 0) taskLine.push(chalk.red(`✗ ${abandonedTasks} abandoned`))
      if (taskLine.length === 0) taskLine.push(chalk.dim('· 0 complete'))

      console.log(`  ${chalk.bold('Tasks:')}     ${taskLine.join(', ')}`)
      console.log(`  ${chalk.bold('Files:')}     ${chalk.dim(`${allTouched.length} touched`)}${unplanned.length > 0 ? chalk.yellow(` (${unplanned.length} unplanned)`) : ''}`)
      console.log(`  ${chalk.bold('Deviations:')} ${deviations.length > 0 ? chalk.magenta(deviations.length) : chalk.dim('0')}`)

      if (deviations.length > 0) {
        console.log()
        for (const s of deviations) {
          console.log(chalk.magenta(`  ⚡ ${s.deviation?.reason}`))
          if (s.deviation?.spawned_task) {
            const spawned = graph.tasks.find(t => t.id === s.deviation!.spawned_task)
            console.log(chalk.dim(`     → spawned ${spawned?.intent || s.deviation.spawned_task}`))
          }
        }
      }
    } else {
      console.log(chalk.dim('  No tasks planned'))
    }

    if (notes.length > 0) {
      console.log()
      console.log(`  ${chalk.bold('Notes:')}     ${notes.length}`)
      for (const n of notes) {
        const tag = n.source === 'ai' ? chalk.cyan('[ai]') : chalk.yellow('[dev]')
        console.log(chalk.dim(`  ${tag} ${n.text}`))
      }
    }

    console.log()
    console.log(chalk.dim(`  Archived to .intent/history/${graph.session.id}.yml`))
    console.log()
    return
  }

  // Complete current step
  let currentTask = tracker.getCurrentTask()
  let currentStep = tracker.getCurrentStep()

  if (!currentTask && !currentStep) {
    console.log(chalk.yellow('No in-progress step'))
    console.log(chalk.dim('Use `throughline status` to see current state, or `throughline done --session` to close the session'))
    return
  }

  // If no step is in_progress but the task has a deviated step, skip past it
  if (!currentStep && currentTask) {
    const deviatedStep = currentTask.steps.find(s => s.status === 'deviated')
    if (deviatedStep) {
      tracker.completeStep(currentTask.id, deviatedStep.id)
      console.log(chalk.magenta(`✓ Deviation acknowledged: ${deviatedStep.intent}`))
      // Fall through to advance logic below
    } else {
      console.log(chalk.yellow('No in-progress step'))
      console.log(chalk.dim('Use `throughline status` to see current state'))
      return
    }
  } else if (currentStep) {
    tracker.completeStep(currentTask!.id, currentStep.id)
    console.log(chalk.green(`✓ Step complete: ${currentStep.intent}`))
  }

  // Advance to next step
  const graph = store.read()
  currentTask = graph.tasks.find(t => t.id === currentTask!.id)!
  const nextStep = currentTask.steps.find(s => s.status === 'pending')

  const ctx = new ContextBuilder(store)
  ctx.writeContextFile('cmd-done-step')

  if (nextStep) {
    tracker.setStepStatus(currentTask.id, nextStep.id, 'in_progress')
    ctx.writeContextFile('cmd-done-advance')
    console.log(chalk.blue(`▶ Next step: ${nextStep.intent}`))
  } else {
    const nextTask = graph.tasks.find(t => t.status === 'pending')
    if (nextTask) {
      console.log(chalk.green(`✓ Task complete: ${currentTask.intent}`))
      console.log(chalk.blue(`▶ Next task: ${nextTask.intent}`))
    } else {
      console.log(chalk.green('✓ All tasks complete'))
      console.log(chalk.dim('  Run `throughline done --session` to close the session'))
    }
  }
}

// ─── attach ───────────────────────────────────────────────────────────────

export async function cmdAttach(options: { cwd?: string } = {}) {
  const store = new SessionStore(options.cwd)
  const tracker = new TaskTracker(store)
  const contextBuilder = new ContextBuilder(store)

  if (!store.isInitialized()) {
    console.log(chalk.yellow('Run `throughline init` first'))
    return
  }

  if (!store.hasActiveSession()) {
    console.log(chalk.yellow('No active session.'))
    console.log(chalk.dim('  Start one with `throughline start "goal"`'))
    return
  }

  const graph = store.read()

  console.log(chalk.green('✓ Throughline attached'))
  console.log(chalk.white(`  Goal: ${chalk.bold(graph.session.goal)}`))
  console.log(chalk.white(`  ID: ${graph.session.id}`))
  console.log()

  // Print context block for the agent
  const contextBlock = contextBuilder.buildContextBlock()
  console.log(chalk.cyan('─── THROUGHLINE CONTEXT ───'))
  process.stdout.write(contextBlock + '\n')
  console.log(chalk.cyan('───────────────────────────'))
  contextBuilder.logContextRead('attach')
  console.log()

  // Start context read detection
  contextBuilder.startReadWatcher()

  // Start file watcher
  const watcher = new FileWatcher(store, tracker)
  watcher.start((file, plannedFiles) => {
    console.log(chalk.magenta(`\n⚡ Unplanned file touched: ${file}`))
    console.log(chalk.dim(`   Planned: ${plannedFiles.join(', ')}`))
  })

  // Watch session.yml for agent-side updates
  const sessionWatcher = chokidar.watch(store.sessionFile, {
    persistent: true,
    ignoreInitial: true,
  })

  sessionWatcher.on('change', () => {
    try {
      const updated = store.read()
      const completedTasks = updated.tasks.filter(t => t.status === 'complete').length
      const totalTasks = updated.tasks.length
      const deviations = updated.tasks.flatMap(t => t.steps.filter(s => s.deviation)).length
      const currentTask = updated.tasks.find(t => t.status === 'in_progress' || t.status === 'deviated')

      console.log(chalk.dim(`\n[${new Date().toLocaleTimeString()}] Session updated`))
      console.log(chalk.white(`  Tasks: ${completedTasks}/${totalTasks} complete, ${deviations} deviations`))
      if (currentTask) {
        const currentStep = currentTask.steps.find(s => s.status === 'in_progress')
        console.log(chalk.blue(`  Current: [${currentTask.id}] ${currentTask.intent}`))
        if (currentStep) {
          console.log(chalk.dim(`    Step: [${currentStep.id}] ${currentStep.intent}`))
        }
      }
      if (currentTask && updated.session.status === 'complete') {
        console.error(chalk.green('\n✓ Session complete'))
      }
    } catch {
      // file may be in inconsistent state during write
    }
  })

  // Block until session is closed (session.yml deleted or status terminal)
  await new Promise<void>((resolve) => {
    sessionWatcher.on('unlink', (filePath) => {
      if (filePath === store.sessionFile) {
        resolve()
      }
    })

    // Also resolve if session status becomes terminal
    const statusCheck = setInterval(() => {
      try {
        const graph = store.read()
        if (graph.session.status === 'complete' || graph.session.status === 'abandoned') {
          clearInterval(statusCheck)
          contextBuilder.stopReadWatcher()
          resolve()
        }
      } catch { /* swallow */ }
    }, 2000)
  })

  watcher.stop()
  await sessionWatcher.close()

  console.log()
  console.log(chalk.green('✓ Session closed'))
}

// ─── Agent launcher ───────────────────────────────────────────────────────

async function launchAgent(
  agent: Agent,
  goal: string,
  systemPrompt: string,
  store: SessionStore,
  tracker: TaskTracker,
  contextBuilder: ContextBuilder,
): Promise<void> {
  const watcher = new FileWatcher(store, tracker)

  watcher.start((file, plannedFiles) => {
    console.log(chalk.magenta(`\n⚡ Unplanned file touched: ${file}`))
    console.log(chalk.dim(`   Planned: ${plannedFiles.join(', ')}`))
    console.log(chalk.dim('   Run `throughline deviate "reason"` if this represents a plan change'))
  })

  const agentCmd = getAgentCommand(agent)
  if (!agentCmd) {
    console.log(chalk.yellow(`Agent "${agent}" not found. Throughline context is ready.`))
    console.log(chalk.dim('Start your agent manually. The intent context is in .intent/session.yml'))
    console.log()
    console.log(chalk.dim('Context block that will be injected:'))
    console.log(chalk.dim(systemPrompt))
    watcher.stop()
    return
  }

  console.log(chalk.dim(`Launching ${agent}...`))
  console.log(chalk.dim('Throughline is watching for file changes and deviation markers'))
  console.log()

  const session = store.read()

  contextBuilder.startReadWatcher()

  const ptySession = new PtySession({
    cmd: agentCmd.cmd,
    args: agentCmd.args,
    env: {
      ...process.env,
      THROUGHLINE_CONTEXT: systemPrompt,
      THROUGHLINE_SESSION: session.session.id,
      FORCE_COLOR: '1',
      TERM: process.env.TERM || 'xterm-256color',
    },
  })

  const markerScanner = new MarkerScanner()

  const refreshContext = () => contextBuilder.writeContextFile('marker')

  markerScanner.onDeviationDetected((event) => {
    const currentTask = tracker.getCurrentTask()
    const currentStep = tracker.getCurrentStep()
    if (currentTask && currentStep) {
      tracker.recordDeviation(currentTask.id, currentStep.id, {
        reason: event.reason,
        spawned_task: event.spawns,
        recorded_at: new Date().toISOString(),
      })
      refreshContext()
      console.error(chalk.magenta(`\n⚡ Deviation detected: ${event.reason}`))
      if (event.spawns) console.error(chalk.magenta(`   Spawned: ${event.spawns}`))
    }
  })

  markerScanner.onPlanCaptured((event) => {
    if (store.read().tasks.length === 0) {
      tracker.addTasks(event.tasks.map(t => ({
        intent: t.intent,
        declared_by: 'ai' as const,
        status: 'pending' as const,
        depends_on: [],
        steps: t.steps.map(s => ({
          id: '',
          intent: s.intent,
          declared_by: 'ai' as const,
          status: 'pending' as const,
          files: { planned: s.files, touched: [] },
          deviation: null,
          completed_at: null,
        })),
      })))
      console.error(chalk.green('\n✓ Intent plan captured from agent'))
      // Auto-start first step
      const firstTask = tracker.getCurrentTask()
      const firstStep = tracker.getCurrentStep()
      if (!firstTask && !firstStep) {
        const graph = store.read()
        const t0 = graph.tasks[0]
        if (t0 && t0.steps[0]) {
          tracker.setStepStatus(t0.id, t0.steps[0].id, 'in_progress')
          refreshContext()
          console.error(chalk.blue(`\n▶ Started: ${t0.steps[0].intent}`))
        }
      }
      refreshContext()
    }
  })

  markerScanner.onStepDone(() => {
    const currentTask = tracker.getCurrentTask()
    const currentStep = tracker.getCurrentStep()
    if (currentTask && currentStep) {
      tracker.completeStep(currentTask.id, currentStep.id)
      refreshContext()
      console.error(chalk.green(`\n✓ Step complete: ${currentStep.intent}`))

      // Advance to next step
      const graph = store.read()
      const task = graph.tasks.find(t => t.id === currentTask.id)!
      const nextStep = task.steps.find(s => s.status === 'pending')
      if (nextStep) {
        tracker.setStepStatus(task.id, nextStep.id, 'in_progress')
        refreshContext()
        console.error(chalk.blue(`▶ Next step: ${nextStep.intent}`))
      } else {
        const nextTask = graph.tasks.find(t => t.status === 'pending')
        if (nextTask) {
          console.error(chalk.green(`✓ Task complete: ${task.intent}`))
          console.error(chalk.blue(`▶ Next task: ${nextTask.intent}`))
        }
      }
    }
  })

  markerScanner.onNote((event) => {
    store.addNote(event.text, 'ai', event.category)
    refreshContext()
    const category = event.category ? chalk.dim(` [${event.category}]`) : ''
    console.error(chalk.cyan(`\n📝 Note${category}: ${event.text}`))
  })

  markerScanner.onContextRead(() => {
    contextBuilder.logContextRead('agent')
    console.error(chalk.dim(`\n[${new Date().toLocaleTimeString()}] Agent read context`))
  })

  ptySession.onData((data: string) => {
    markerScanner.feed(data)
  })

  // Block until the PTY session ends, then auto-close or prompt
  await new Promise<void>((resolve) => {
    ptySession.onExit(() => {
      contextBuilder.stopReadWatcher()
      watcher.stop()
      console.error()
      console.error(chalk.dim('Agent session ended'))

      const graph = store.read()
      const allDone = graph.tasks.length > 0 && graph.tasks.every(t => t.status === 'complete' || t.status === 'abandoned')

      if (allDone) {
        store.closeSession('complete')
        console.error(chalk.green('\n✓ Session auto-closed (all tasks complete)'))
        resolve()
      } else {
        const rl = readline.createInterface({ input: process.stdin, output: process.stderr })
        rl.question(chalk.yellow('\nClose session? (y/N) '), (answer) => {
          if (answer.toLowerCase() === 'y') {
            store.closeSession('abandoned')
            console.error(chalk.green('\n✓ Session closed'))
          } else {
            console.error(chalk.dim('\nRun `throughline done --session` to close later'))
          }
          rl.close()
          resolve()
        })
      }
    })
  })
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function detectAgent(): Agent {
  const which = process.platform === 'win32' ? 'where' : 'which'
  try {
    execSync(`${which} claude`, { stdio: 'pipe' })
    return 'claude-code'
  } catch {}
  try {
    execSync(`${which} opencode`, { stdio: 'pipe' })
    return 'opencode'
  } catch {}
  return 'other'
}

function getAgentCommand(agent: Agent): { cmd: string; args: string[] } | null {
  const commands: Record<string, { cmd: string; args: string[] }> = {
    'claude-code': { cmd: 'claude', args: [] },
    'opencode': { cmd: 'opencode', args: [] },
    'gemini-cli': { cmd: 'gemini', args: [] },
  }
  const entry = commands[agent]
  if (!entry) return null

  // On Windows, resolve .cmd shims to the real .exe for node-pty
  if (process.platform === 'win32') {
    const resolved = resolveWin32Exe(entry.cmd)
    return { cmd: resolved, args: entry.args }
  }

  return entry
}

// Resolves npm .cmd shims to the actual .exe on Windows.
// node-pty needs a real executable, not a batch file.
function resolveWin32Exe(name: string): string {
  try {
    const output = execSync(`where ${name}`, { encoding: 'utf8', shell: 'cmd.exe' }).trim()
    const paths = output.split('\n').map((s: string) => s.trim()).filter(Boolean)

    // Read .cmd shim to extract the real .exe path
    const cmdShim = paths.find((p: string) => /\.cmd$/i.test(p) || /\.bat$/i.test(p))
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

    // Fallback: return the command name as-is (will fail with node-pty but gives clear error)
    return name
  } catch {
    return name
  }
}

// ─── note ─────────────────────────────────────────────────────────────────

export function cmdNote(text: string, options: { cwd?: string; category?: string } = {}) {
  const store = new SessionStore(options.cwd)

  if (!store.hasActiveSession()) {
    console.log(chalk.yellow('No active session'))
    return
  }

  store.addNote(text, 'developer', options.category)
  const cBuilder = new ContextBuilder(store)
  cBuilder.writeContextFile('cmd-note')
  console.log(chalk.green(`✓ Note recorded`))
  console.log(chalk.dim(`  "${text}"`))
}

// ─── resume / repair / continue ───────────────────────────────────────────

export async function cmdResume(options: { agent?: string; cwd?: string } = {}) {
  const store = new SessionStore(options.cwd)
  const tracker = new TaskTracker(store)
  const contextBuilder = new ContextBuilder(store)

  if (!store.isInitialized()) {
    console.log(chalk.yellow('Run `throughline init` first'))
    return
  }

  if (store.hasActiveSession()) {
    const graph = store.read()
    console.log(chalk.yellow(`⚠  Active session exists: "${graph.session.goal}"`))
    console.log(chalk.dim('  Close it first with `throughline done --session`'))
    return
  }

  const last = store.getLastSession()
  if (!last) {
    console.log(chalk.yellow('No previous session found'))
    console.log(chalk.dim('  Start a new session with `throughline start "your goal"`'))
    return
  }

  // Find incomplete tasks to resume
  const incompleteTasks = last.tasks.filter(t => t.status !== 'complete' && t.status !== 'abandoned')
  const completedTasks = last.tasks.filter(t => t.status === 'complete')

  console.log(chalk.white(`Resuming: "${last.session.goal}"`))
  console.log(chalk.dim(`  Previous session: ${last.session.id}`))
  if (completedTasks.length > 0) {
    console.log(chalk.green(`  ✓ ${completedTasks.length} tasks already complete`))
  }
  if (incompleteTasks.length > 0) {
    console.log(chalk.blue(`  ▶ ${incompleteTasks.length} tasks remaining`))
  }
  console.log()

  const agent = (options.agent as Agent) || last.session.agent
  const graph = store.createSession(last.session.goal, agent, { id: last.session.id, relation: 'resume' })

  // Carry over incomplete tasks
  if (incompleteTasks.length > 0) {
    tracker.addTasks(incompleteTasks.map(t => ({
      ...t,
      status: 'pending' as const,
      steps: t.steps
        .filter(s => s.status !== 'complete')
        .map(s => ({ ...s, status: 'pending' as const })),
    })))
  }

  console.log(chalk.green(`✓ Resume session started: ${graph.session.id}`))
  contextBuilder.writeContextFile('resume', last)
  const contextBlock = contextBuilder.buildContextBlock(last)
  const systemPrompt = buildAgentSystemPrompt(contextBlock)
  await launchAgent(agent, last.session.goal, systemPrompt, store, tracker, contextBuilder)
}

export async function cmdRepair(options: { agent?: string; cwd?: string } = {}) {
  const store = new SessionStore(options.cwd)
  const tracker = new TaskTracker(store)
  const contextBuilder = new ContextBuilder(store)

  if (!store.isInitialized()) {
    console.log(chalk.yellow('Run `throughline init` first'))
    return
  }

  if (store.hasActiveSession()) {
    const graph = store.read()
    console.log(chalk.yellow(`⚠  Active session exists: "${graph.session.goal}"`))
    console.log(chalk.dim('  Close it first with `throughline done --session`'))
    return
  }

  const last = store.getLastSession()
  if (!last) {
    console.log(chalk.yellow('No previous session to repair'))
    return
  }

  // Surface what broke or what was noted
  const deviations = last.tasks.flatMap(t => t.steps.filter(s => s.deviation))
  const notes = last.session.notes

  console.log(chalk.white(`Repairing: "${last.session.goal}"`))
  console.log(chalk.dim(`  Previous session: ${last.session.id}  Status: ${last.session.status}`))

  if (deviations.length > 0) {
    console.log(chalk.magenta(`  ⚡ ${deviations.length} deviations to address:`))
    deviations.forEach(s => console.log(chalk.dim(`     · ${s.deviation?.reason}`)))
  }
  if (notes.length > 0) {
    console.log(chalk.dim(`  📝 ${notes.length} notes from last session`))
  }
  console.log()

  // Repair goal — prompt developer to describe what to fix
  const repairGoal = `fix issues from: "${last.session.goal}"`
  const agent = (options.agent as Agent) || last.session.agent
  const graph = store.createSession(repairGoal, agent, { id: last.session.id, relation: 'repair' })

  console.log(chalk.green(`✓ Repair session started: ${graph.session.id}`))
  console.log(chalk.dim('  Describe the specific issues to the agent — previous context is injected'))
  console.log()

  contextBuilder.writeContextFile('repair', last)
  const contextBlock = contextBuilder.buildContextBlock(last)
  const systemPrompt = buildAgentSystemPrompt(contextBlock)
  await launchAgent(agent, repairGoal, systemPrompt, store, tracker, contextBuilder)
}

export async function cmdContinue(goal: string, options: { agent?: string; cwd?: string } = {}) {
  const store = new SessionStore(options.cwd)
  const tracker = new TaskTracker(store)
  const contextBuilder = new ContextBuilder(store)

  if (!store.isInitialized()) {
    console.log(chalk.yellow('Run `throughline init` first'))
    return
  }

  if (store.hasActiveSession()) {
    const graph = store.read()
    console.log(chalk.yellow(`⚠  Active session exists: "${graph.session.goal}"`))
    console.log(chalk.dim('  Close it first with `throughline done --session`'))
    return
  }

  const last = store.getLastSession()
  if (!last) {
    console.log(chalk.yellow('No previous session found — starting fresh'))
    return cmdStart(goal, options)
  }

  const agent = (options.agent as Agent) || last.session.agent
  const graph = store.createSession(goal, agent, { id: last.session.id, relation: 'continue' })

  console.log(chalk.green(`✓ Continuation session started: ${graph.session.id}`))
  console.log(chalk.white(`  Goal: ${chalk.bold(goal)}`))
  console.log(chalk.dim(`  Continues from: ${last.session.id} "${last.session.goal}"`))
  console.log()

  contextBuilder.writeContextFile('continue', last)
  const contextBlock = contextBuilder.buildContextBlock(last)
  const systemPrompt = buildAgentSystemPrompt(contextBlock)
  await launchAgent(agent, goal, systemPrompt, store, tracker, contextBuilder)
}

// ─── history ──────────────────────────────────────────────────────────────

export function cmdHistory(options: { cwd?: string } = {}) {
  const store = new SessionStore(options.cwd)

  if (!store.isInitialized()) {
    console.log(chalk.yellow('Not initialized. Run `throughline init`'))
    return
  }

  const sessions = store.listSessions()

  if (sessions.length === 0) {
    console.log(chalk.dim('No session history yet'))
    return
  }

  console.log()
  console.log(chalk.bold(`SESSION HISTORY  (${sessions.length} sessions)`))
  console.log()

  for (const s of sessions) {
    const statusColor = {
      complete: chalk.green,
      abandoned: chalk.red,
      in_progress: chalk.blue,
      deviated: chalk.magenta,
      pending: chalk.yellow,
    }[s.session.status] || chalk.white

    const completedTasks = s.tasks.filter(t => t.status === 'complete').length
    const deviations = s.tasks.flatMap(t => t.steps.filter(st => st.deviation)).length
    const notes = s.session.notes.length

    console.log(statusColor(`  ${s.session.id}`) + chalk.dim(` — ${s.session.goal}`))
    console.log(chalk.dim(`    ${s.session.agent}  ·  ${new Date(s.session.started_at).toLocaleDateString()}  ·  ${completedTasks}/${s.tasks.length} tasks  ·  ${deviations} deviations  ·  ${notes} notes`))

    if (s.session.relation && s.session.parent_session) {
      console.log(chalk.dim(`    ${s.session.relation} of ${s.session.parent_session}`))
    }
    console.log()
  }
}
