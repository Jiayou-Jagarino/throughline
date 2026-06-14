// ─── Command handlers ────────────────────────────────────────────────────
// All CLI command implementations. Each exported cmd* function corresponds
// to a throughline subcommand registered in src/index.ts.
//
// Two agent strategies:
//   wrap  — spawns agent as child process, pipes stdio, scans markers
//           (claude-code, gemini-cli)
//   bridge — starts opencode serve + SSE listener, opens attach terminal
//           (opencode)
import chalk from 'chalk'
import chokidar from 'chokidar'
import readline from 'readline'
import { execSync, spawn } from 'child_process'
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { z } from 'zod/v4'

import { SessionStore } from '../engine/SessionStore.js'
import { TaskTracker } from '../engine/TaskTracker.js'
import { ContextBuilder } from '../engine/ContextBuilder.js'
import { FileWatcher } from '../engine/FileWatcher.js'
import { OpenCodeBridge, resolveOpenCodeExe } from '../engine/OpenCodeBridge.js'
import { MarkerScanner } from '../session/MarkerScanner.js'
import { buildAgentSystemPrompt } from '../parsers/deviationParser.js'
import { debug } from '../utils/logger.js'
import type { Agent, IntentGraph } from '../types.js'

const AgentSchema = z.enum(['claude-code', 'opencode', 'gemini-cli', 'other'])

// ─── Agent detection ─────────────────────────────────────────────────────
// Auto-detects which AI agent is installed (claude-code, opencode,
// gemini-cli) by trying `where`/`which` in priority order.

function resolveAgent(raw: string | undefined): Agent {
  if (!raw) return detectAgent()
  const result = AgentSchema.safeParse(raw)
  if (!result.success) {
    console.error(chalk.yellow(`⚠ Unknown agent "${raw}". Options: claude-code, opencode, gemini-cli. Falling back to auto-detect.`))
    return detectAgent()
  }
  return result.data
}

// ─── init ─────────────────────────────────────────────────────────────────

export function cmdInit(options: { cwd?: string; force?: boolean } = {}) {
  const store = new SessionStore(options.cwd)

  if (store.isInitialized()) {
    if (!options.force) {
      console.log(chalk.yellow('⚠  .intent/ already exists in this directory'))
      console.log(chalk.dim('  Use --force to reinitialize'))
      return
    }
    console.log(chalk.dim('Reinitializing...'))
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

export async function cmdStart(goal: string, options: { agent?: string; setup?: boolean; cwd?: string; watchDepth?: number } = {}) {
  const store = new SessionStore(options.cwd)
  const tracker = new TaskTracker(store)
  const contextBuilder = new ContextBuilder(store)

  if (!store.isInitialized()) {
    store.init()
    console.log(chalk.green('✓ Throughline initialized'))
    console.log(chalk.dim('  Created .intent/ directory'))
    console.log()
  }

  if (store.hasActiveSession()) {
    const graph = store.read()
    console.log(chalk.yellow(`⚠  Active session exists: "${graph.session.goal}"`))
    console.log(chalk.dim('  Run `throughline status` to see it, or `throughline done --session` to close it'))
    return
  }

  const agent = resolveAgent(options.agent)
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
  const startWd = Number(options.watchDepth) || 3
  await launchAgent(agent, goal, systemPrompt, store, tracker, contextBuilder, startWd)
}

// ─── status ───────────────────────────────────────────────────────────────

export function cmdStatus(options: { cwd?: string; json?: boolean } = {}) {
  const store = new SessionStore(options.cwd)

  if (!store.isInitialized()) {
    console.log(chalk.yellow('Not initialized. Run `throughline init`'))
    return
  }

  if (!store.hasActiveSession()) {
    if (options.json) { console.log('{}'); return }
    console.log(chalk.yellow('No active session'))
    console.log(chalk.dim('  Start one with: throughline start "your goal"'))
    return
  }

  const graph = store.read()
  const { session, tasks } = graph

  if (options.json) {
    console.log(JSON.stringify(graph, null, 2))
    return
  }

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
    console.log(chalk.dim('  Start one with: throughline start "your goal"'))
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
    console.log(chalk.dim('  Start one with: throughline start "your goal"'))
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

export async function cmdAttach(options: { cwd?: string; watchDepth?: number } = {}) {
  const store = new SessionStore(options.cwd)
  const tracker = new TaskTracker(store)
  const contextBuilder = new ContextBuilder(store)

  if (!store.isInitialized()) {
    store.init()
    console.log(chalk.green('✓ Throughline initialized'))
    console.log(chalk.dim('  Created .intent/ directory'))
    console.log()
  }

  if (!store.hasActiveSession()) {
    console.log(chalk.yellow('No active session'))
    console.log(chalk.dim('  Start one with: throughline start "your goal"'))
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
  const watcher = new FileWatcher(store, tracker, undefined, Number(options.watchDepth) || 3)
  watcher.start((file, plannedFiles) => {
    console.error(chalk.magenta(`\n⚡ Unplanned file touched: ${file}`))
    console.error(chalk.dim(`   Planned: ${plannedFiles.join(', ')}`))
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
    } catch (err) {
      // file may be in inconsistent state during write
      console.error(`[throughline] Session watch error: ${(err as Error).message}`)
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
      } catch (err) {
        console.error(`[throughline] Status check error: ${(err as Error).message}`)
      }
    }, 2000)
  })

  watcher.stop()
  await sessionWatcher.close()

  console.log()
  console.log(chalk.green('✓ Session closed'))
}

// ─── Agent launcher ─────────────────────────────────────────────────────
// Routes to the correct launch strategy based on agent type.

async function launchAgent(
  agent: Agent,
  goal: string,
  systemPrompt: string,
  store: SessionStore,
  tracker: TaskTracker,
  contextBuilder: ContextBuilder,
  watchDepth: number = 3,
): Promise<void> {
  if (agent === 'opencode') {
    await launchOpenCodeBridge(goal, systemPrompt, store, tracker, contextBuilder, watchDepth)
    return
  }

  const agentCmd = getAgentCommand(agent)
  if (!agentCmd) {
    console.log(chalk.yellow('Agent not found — context is ready.'))
    console.log(chalk.dim('  .intent/context.txt has been written'))
    console.log()
    console.log(chalk.cyan('─── THROUGHLINE CONTEXT ───'))
    process.stdout.write(contextBuilder.buildContextBlock() + '\n')
    console.log(chalk.cyan('───────────────────────────'))
    return
  }

  // ── Wrap strategy (claude-code via pipes) ─────────────────────────────────
  const watcher = new FileWatcher(store, tracker, undefined, watchDepth)
  watcher.start((file, plannedFiles) => {
    console.error(chalk.magenta('\n⚡ Unplanned file touched: ' + file))
    console.error(chalk.dim('   Planned: ' + plannedFiles.join(', ')))
  })

  console.log(chalk.dim('Launching ' + agent + '...'))
  console.log(chalk.dim('Throughline is watching for file changes and deviation markers'))
  console.log()

  const session = store.read()
  contextBuilder.startReadWatcher()

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
      console.error(chalk.magenta('\n⚡ Deviation detected: ' + event.reason))
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
      console.error(chalk.green('\n✓ Intent plan captured'))
      const firstTask = tracker.getCurrentTask()
      const firstStep = tracker.getCurrentStep()
      if (!firstTask && !firstStep) {
        const graph = store.read()
        const t0 = graph.tasks[0]
        if (t0 && t0.steps[0]) {
          tracker.setStepStatus(t0.id, t0.steps[0].id, 'in_progress')
          refreshContext()
          console.error(chalk.blue('\n▶ Started: ' + t0.steps[0].intent))
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
      console.error(chalk.green('\n✓ Step complete: ' + currentStep.intent))
      const graph = store.read()
      const task = graph.tasks.find(t => t.id === currentTask.id)!
      const nextStep = task.steps.find(s => s.status === 'pending')
      if (nextStep) {
        tracker.setStepStatus(task.id, nextStep.id, 'in_progress')
        refreshContext()
        console.error(chalk.blue('▶ Next step: ' + nextStep.intent))
      } else {
        const nextTask = graph.tasks.find(t => t.status === 'pending')
        if (nextTask) {
          console.error(chalk.green('✓ Task complete: ' + task.intent))
          console.error(chalk.blue('▶ Next task: ' + nextTask.intent))
        }
      }
    }
  })

  markerScanner.onNote((event) => {
    store.addNote(event.text, 'ai', event.category)
    refreshContext()
    console.error(chalk.cyan('\n📝 Note: ' + event.text))
  })

  markerScanner.onContextRead(() => {
    contextBuilder.logContextRead('agent')
  })

  let agentExited = false
  let agentExitCode = 0
  let sigintCount = 0
  let sigintTimer: ReturnType<typeof setTimeout> | null = null

  const child = spawn(agentCmd.cmd, agentCmd.args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd: store.rootDir,
    env: {
      ...process.env,
      THROUGHLINE_CONTEXT: systemPrompt,
      THROUGHLINE_SESSION: session.session.id,
      FORCE_COLOR: '1',
      TERM: process.env.TERM || 'xterm-256color',
    },
  })

  child.stdout.on('data', (data: Buffer) => {
    const text = data.toString()
    process.stdout.write(text)
    markerScanner.feed(text)
  })

  child.stderr.on('data', (data: Buffer) => {
    process.stderr.write(data.toString())
  })

  process.stdin.resume()
  process.stdin.on('data', (data: Buffer) => {
    const input = data.toString()
    if (input === '\x03') {
      if (sigintCount > 0) { child.kill(); return }
      sigintCount++
      sigintTimer = setTimeout(() => { sigintCount = 0 }, 2000)
      return
    }
    sigintCount = 0
    if (!child.killed) child.stdin!.write(data)
  })

  if (process.stdin.isTTY) process.stdin.setRawMode(true)

  child.on('exit', (code) => {
    agentExited = true
    agentExitCode = code ?? 0
    process.stdin.removeAllListeners('data')
    process.stdin.pause()
    if (process.stdin.isTTY && process.stdin.setRawMode) {
      try { process.stdin.setRawMode(false) } catch {}
    }
    if (sigintTimer) clearTimeout(sigintTimer)
  })

  while (!agentExited) {
    await new Promise<void>((r) => setTimeout(r, 500))
  }

  contextBuilder.stopReadWatcher()
  watcher.stop()
  console.error()
  console.error(chalk.dim('Agent session ended (exit code ' + agentExitCode + ')'))

  const graph = store.read()
  const allDone = graph.tasks.length > 0 && graph.tasks.every(t => t.status === 'complete' || t.status === 'abandoned')

  if (allDone) {
    store.closeSession('complete')
    console.error(chalk.green('\n✓ Session auto-closed (all tasks complete)'))
  } else {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr })
    await new Promise<void>((resolve) => {
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
    })
  }

  process.exit(0)
}

// ─── OpenCode bridge launcher ─────────────────────────────────────────────

async function launchOpenCodeBridge(
  goal: string,
  systemPrompt: string,
  store: SessionStore,
  tracker: TaskTracker,
  contextBuilder: ContextBuilder,
  watchDepth: number = 3,
): Promise<void> {
  const bridge = new OpenCodeBridge({
    store,
    tracker,
    contextBuilder,
    onFileTouch: (file) => {
      console.error(chalk.dim('[' + new Date().toLocaleTimeString() + '] touched: ' + file))
    },
    onTodoUpdate: (todos) => {
      const done = todos.filter(t => t.status === 'completed').length
      console.error(chalk.dim('[' + new Date().toLocaleTimeString() + '] todos: ' + done + '/' + todos.length + ' complete'))
    },
    onSessionIdle: () => {
      console.error(chalk.dim('[' + new Date().toLocaleTimeString() + '] agent idle — context synced'))
    },
    onSessionCreated: (id) => {
      console.error(chalk.dim('[' + new Date().toLocaleTimeString() + '] opencode session: ' + id))
    },
  })

  const serverReady = await bridge.startServer()
  if (!serverReady) {
    console.log(chalk.red('✗ Could not start OpenCode server'))
    console.log(chalk.dim('  Start it manually: opencode serve --port 4096'))
    console.log(chalk.dim('  Then run: opencode attach http://localhost:4096'))
    return
  }

  writeAgentsMd(store, systemPrompt)
  bridge.startSSE()
  contextBuilder.startReadWatcher()

  const fileWatcher = new FileWatcher(store, tracker, store.rootDir, watchDepth)
  fileWatcher.start((file, plannedFiles) => {
    console.error(chalk.magenta('\n⚡ Unplanned file touched: ' + file))
    console.error(chalk.dim('   Planned: ' + plannedFiles.join(', ')))
  })

  console.log()
  console.log(chalk.green('✓ Throughline is watching your OpenCode session'))
  console.log()

  // Auto-launch opencode attach in a new terminal window
  const agentExe = resolveOpenCodeExe()
  if (!agentExe) {
    console.log(chalk.yellow('opencode not found — attach manually:'))
    console.log(chalk.cyan(`  opencode attach http://localhost:${bridge.getPort()}`))
  } else {
    const port = bridge.getPort()
    const tmpScript = path.join(tmpdir(), `tl-opencode-${Date.now()}.cmd`)
    writeFileSync(tmpScript, `@echo off\r\n"${agentExe}" attach http://localhost:${port}\r\nexit /b %errorlevel%\r\n`, 'utf8')

    console.log(chalk.green('✓ OpenCode session started'))
    console.log(chalk.dim('  A new terminal window has opened for OpenCode'))
    console.log(chalk.dim('  Close that window or exit OpenCode when done'))
    console.log()

    const client = spawn('cmd.exe', ['/c', 'start', '"OpenCode"', '/wait', 'cmd.exe', '/c', tmpScript], {
      stdio: 'ignore',
    })

    await new Promise<void>((resolve) => {
      process.on('SIGINT', () => resolve())
      client.on('exit', () => { try { unlinkSync(tmpScript) } catch {}; resolve() })
      client.on('error', () => {
        try { unlinkSync(tmpScript) } catch {}
        console.log(chalk.yellow('Could not open terminal window — attach manually:'))
        console.log(chalk.cyan(`  opencode attach http://localhost:${port}`))
        resolve()
      })
    })

    console.log(chalk.dim('\nOpenCode window closed'))
  }

  console.log()
  console.log(chalk.dim('Run `throughline status` to see intent graph'))
  console.log(chalk.dim('Run `throughline done --session` to end session'))
  console.log()

  fileWatcher.stop()
  bridge.stopSSE()
  contextBuilder.stopReadWatcher()

  // Multi-option menu after opencode closes
  const graph = store.read()
  const allDone = graph.tasks.length > 0 && graph.tasks.every(t => t.status === 'complete' || t.status === 'abandoned')
  const doneCount = graph.tasks.filter(t => t.status === 'complete').length
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })

  const ask = (): Promise<string> => {
    return new Promise((resolve) => {
      console.log()
      console.log(chalk.dim(`Session: ${graph.tasks.length} tasks (${doneCount} complete)`))
      console.log(chalk.dim('─────────────────────────────────────'))
      console.log(chalk.white('  [s] Status — view intent graph'))
      console.log(chalk.white('  [d] Done — close session'))
      console.log(chalk.white('  [k] Keep open — close later'))
      console.log(chalk.dim('─────────────────────────────────────'))
      const defaultKey = allDone ? 'd' : 'k'
      const prompt = chalk.green(`What now? (s/d/k) [${defaultKey}]: `)
      rl.question(prompt, (a) => { resolve(a.trim().toLowerCase() || defaultKey) })
    })
  }

  let done = false
  while (!done) {
    const answer = await ask()
    if (answer === 's') {
      cmdStatus({ cwd: store.rootDir })
    } else if (answer === 'd') {
      store.closeSession(allDone ? 'complete' : 'abandoned')
      console.log(chalk.green('\n✓ Session closed'))
      done = true
    } else {
      console.log(chalk.dim('\nSession kept open — run `throughline done --session` to close later'))
      done = true
    }
  }
  rl.close()
}

// ─── Write AGENTS.md ──────────────────────────────────────────────────────

function writeAgentsMd(store: SessionStore, contextBlock: string): void {
  const agentsMdPath = path.join(store.rootDir, 'AGENTS.md')
  const content = '# Throughline Session Context\n\n' + contextBlock + '\n'
  writeFileSync(agentsMdPath, content, 'utf8')
  console.log(chalk.dim('  AGENTS.md updated with session context'))
}


// ─── Helpers ──────────────────────────────────────────────────────────────

// Parses a command string into cmd + args, handling quoted strings like:
//   node "path with spaces/file.js" --flag  →  ["node", "path with spaces/file.js", "--flag"]
function parseCommandLine(input: string): string[] {
  const parts: string[] = []
  let current = ''
  let inQuote = false
  for (const ch of input.trim()) {
    if (ch === '"') { inQuote = !inQuote; continue }
    if (ch === ' ' && !inQuote) { if (current) { parts.push(current); current = '' }; continue }
    current += ch
  }
  if (current) parts.push(current)
  return parts
}

function detectAgent(): Agent {
  const which = process.platform === 'win32' ? 'where' : 'which'
  try {
    execSync(`${which} claude`, { stdio: 'pipe' })
    return 'claude-code'
  } catch {
    // claude not found, try next
  }
  try {
    execSync(`${which} opencode`, { stdio: 'pipe' })
    return 'opencode'
  } catch {
    // opencode not found, try next
  }
  return 'other'
}

function getAgentCommand(agent: Agent): { cmd: string; args: string[] } | null {
  // Allow override via env var for testing
  const agentBin = process.env.THROUGHLINE_AGENT_BIN
  if (agentBin) {
    const parts = parseCommandLine(agentBin)
    const resolved = resolveWin32Exe(parts[0])
    return { cmd: resolved, args: parts.slice(1) }
  }

  const commands: Record<string, { cmd: string; args: string[] }> = {
    'claude-code': { cmd: 'claude', args: [] },
    'opencode': { cmd: 'opencode', args: [] },
    'gemini-cli': { cmd: 'gemini', args: [] },
  }
  const entry = commands[agent]
  if (!entry) return null

  if (process.platform === 'win32') {
    const resolved = resolveWin32Exe(entry.cmd)
    return { cmd: resolved, args: entry.args }
  }

  return entry
}

// Resolves npm .cmd shims to the actual .exe on Windows for spawn().
function resolveWin32Exe(name: string): string {
  try {
    const output = execSync(`where ${name}`, { encoding: 'utf8', shell: 'cmd.exe' }).trim()
    const paths = output.split('\n').map((s: string) => s.trim()).filter(Boolean)
    debug(`where ${name}:`, paths)

    // Look for a direct .exe first
    const exePath = paths.find((p: string) => /\.exe$/i.test(p) && existsSync(p))
    if (exePath) {
      debug(`Found direct exe: ${exePath}`)
      return exePath
    }

    // Read .cmd shim to extract the real .exe path
    const cmdShim = paths.find((p: string) => /\.cmd$/i.test(p) || /\.bat$/i.test(p))
    if (cmdShim) {
      const content = readFileSync(cmdShim, 'utf8')
      const match = content.match(/"([^"]+\.exe)"/)
        || content.match(/"([^"]+\.cmd)"/)
        || content.match(/"([^"]+)"\s*\%\*/)
      if (match) {
        let resolvedPath = match[1]
        // Handle %~dp0, %dp0%, and %~dp0% prefixes
        const dp0Match = resolvedPath.match(/(%\^?~?dp0%?)(.+)/i)
        if (dp0Match) {
          const shimDir = cmdShim.replace(/[/\\][^/\\]*$/, '')
          resolvedPath = shimDir + dp0Match[2]
        }
        // Handle quoted paths
        resolvedPath = resolvedPath.replace(/"/g, '')
        if (existsSync(resolvedPath)) {
          debug(`Resolved via shim: ${resolvedPath}`)
          return resolvedPath
        }
      }
    }

    debug(`No exe or shim found for ${name}, falling back to name`)
    return name
  } catch (err) {
    console.error(`[throughline] Failed to resolve ${name}: ${(err as Error).message}`)
    return name
  }
}

// ─── note ─────────────────────────────────────────────────────────────────

export function cmdNote(text: string, options: { cwd?: string; category?: string } = {}) {
  const store = new SessionStore(options.cwd)

  if (!store.hasActiveSession()) {
    console.log(chalk.yellow('No active session'))
    console.log(chalk.dim('  Start one with: throughline start "your goal"'))
    return
  }

  store.addNote(text, 'developer', options.category)
  const cBuilder = new ContextBuilder(store)
  cBuilder.writeContextFile('cmd-note')
  console.log(chalk.green(`✓ Note recorded`))
  console.log(chalk.dim(`  "${text}"`))
}

// ─── resume / repair / continue ───────────────────────────────────────────

export async function cmdResume(options: { agent?: string; cwd?: string; watchDepth?: number } = {}) {
  const store = new SessionStore(options.cwd)
  const tracker = new TaskTracker(store)
  const contextBuilder = new ContextBuilder(store)

  if (!store.isInitialized()) {
    store.init()
    console.log(chalk.green('✓ Throughline initialized'))
    console.log(chalk.dim('  Created .intent/ directory'))
    console.log()
  }

  if (store.hasActiveSession()) {
    const graph = store.read()
    console.log(chalk.yellow(`⚠  Active session exists: "${graph.session.goal}"`))
    console.log(chalk.dim('  Auto-closing as abandoned...'))
    const ctxBuilder = new ContextBuilder(store)
    ctxBuilder.writeContextFile('cmd-done-session')
    ctxBuilder.stopReadWatcher()
    store.closeSession('abandoned')
    console.log(chalk.dim(`  ✓ Closed session ${graph.session.id}`))
    console.log()
  }

  const sessions = store.listSessions()
  if (sessions.length === 0) {
    console.log(chalk.yellow('No previous session found'))
    console.log(chalk.dim('  Start a new session with `throughline start "your goal"`'))
    return
  }

  let selected: IntentGraph
  if (sessions.length === 1) {
    selected = sessions[0]
  } else {
    console.log(chalk.bold('\nAvailable sessions:\n'))
    sessions.forEach((s, i) => {
      const statusColor = {
        complete: chalk.green,
        abandoned: chalk.red,
        in_progress: chalk.blue,
        deviated: chalk.magenta,
        pending: chalk.yellow,
      }[s.session.status] || chalk.white
      const done = s.tasks.filter(t => t.status === 'complete').length
      console.log(statusColor(`  [${i + 1}] ${s.session.id}`) + chalk.dim(` — ${s.session.goal}`))
      console.log(chalk.dim(`      ${s.session.agent}  ·  ${new Date(s.session.started_at).toLocaleDateString()}  ·  ${done}/${s.tasks.length} tasks`))
    })
    console.log()

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    const pick = await new Promise<number>((resolve) => {
      const prompt = chalk.green(`Pick a session (1-${sessions.length}) [1]: `)
      rl.question(prompt, (a) => {
        const n = parseInt(a.trim(), 10)
        if (n >= 1 && n <= sessions.length) resolve(n - 1)
        else resolve(0)
      })
    })
    rl.close()
    selected = sessions[pick]
  }

  // Find incomplete tasks to resume
  const incompleteTasks = selected.tasks.filter(t => t.status !== 'complete' && t.status !== 'abandoned')
  const completedTasks = selected.tasks.filter(t => t.status === 'complete')

  console.log(chalk.white(`Resuming: "${selected.session.goal}"`))
  console.log(chalk.dim(`  Previous session: ${selected.session.id}`))
  if (completedTasks.length > 0) {
    console.log(chalk.green(`  ✓ ${completedTasks.length} tasks already complete`))
  }
  if (incompleteTasks.length > 0) {
    console.log(chalk.blue(`  ▶ ${incompleteTasks.length} tasks remaining`))
  }
  console.log()

  const agent = options.agent ? resolveAgent(options.agent) : selected.session.agent
  const graph = store.createSession(selected.session.goal, agent, { id: selected.session.id, relation: 'resume' })

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
  contextBuilder.writeContextFile('resume', selected)
  const contextBlock = contextBuilder.buildContextBlock(selected)
  const systemPrompt = buildAgentSystemPrompt(contextBlock)
  await launchAgent(agent, selected.session.goal, systemPrompt, store, tracker, contextBuilder, Number(options.watchDepth) || 3)
}

export async function cmdRepair(options: { agent?: string; cwd?: string; watchDepth?: number } = {}) {
  const store = new SessionStore(options.cwd)
  const tracker = new TaskTracker(store)
  const contextBuilder = new ContextBuilder(store)

  if (!store.isInitialized()) {
    store.init()
    console.log(chalk.green('✓ Throughline initialized'))
    console.log(chalk.dim('  Created .intent/ directory'))
    console.log()
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
  const agent = options.agent ? resolveAgent(options.agent) : last.session.agent
  const graph = store.createSession(repairGoal, agent, { id: last.session.id, relation: 'repair' })

  console.log(chalk.green(`✓ Repair session started: ${graph.session.id}`))
  console.log(chalk.dim('  Describe the specific issues to the agent — previous context is injected'))
  console.log()

  contextBuilder.writeContextFile('repair', last)
  const contextBlock = contextBuilder.buildContextBlock(last)
  const systemPrompt = buildAgentSystemPrompt(contextBlock)
  await launchAgent(agent, repairGoal, systemPrompt, store, tracker, contextBuilder, Number(options.watchDepth) || 3)
}

export async function cmdContinue(goal: string, options: { agent?: string; cwd?: string; watchDepth?: number } = {}) {
  const store = new SessionStore(options.cwd)
  const tracker = new TaskTracker(store)
  const contextBuilder = new ContextBuilder(store)

  if (!store.isInitialized()) {
    store.init()
    console.log(chalk.green('✓ Throughline initialized'))
    console.log(chalk.dim('  Created .intent/ directory'))
    console.log()
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

  const agent = options.agent ? resolveAgent(options.agent) : last.session.agent
  const graph = store.createSession(goal, agent, { id: last.session.id, relation: 'continue' })

  console.log(chalk.green(`✓ Continuation session started: ${graph.session.id}`))
  console.log(chalk.white(`  Goal: ${chalk.bold(goal)}`))
  console.log(chalk.dim(`  Continues from: ${last.session.id} "${last.session.goal}"`))
  console.log()

  contextBuilder.writeContextFile('continue', last)
  const contextBlock = contextBuilder.buildContextBlock(last)
  const systemPrompt = buildAgentSystemPrompt(contextBlock)
  await launchAgent(agent, goal, systemPrompt, store, tracker, contextBuilder, Number(options.watchDepth) || 3)
}

// ─── history ──────────────────────────────────────────────────────────────

export function cmdHistory(options: { cwd?: string; json?: boolean; limit?: string | number } = {}) {
  const store = new SessionStore(options.cwd)

  if (!store.isInitialized()) {
    console.log(chalk.yellow('Not initialized. Run `throughline init`'))
    return
  }

  let sessions = store.listSessions()

  const limit = typeof options.limit === 'string' ? parseInt(options.limit, 10) : options.limit
  if (limit && limit > 0) {
    sessions = sessions.slice(0, limit)
  }

  if (sessions.length === 0) {
    console.log(chalk.dim('No session history yet'))
    return
  }

  if (options.json) {
    console.log(JSON.stringify(sessions, null, 2))
    return
  }

  console.log()
  const totalSessions = store.listSessions().length
  const shown = sessions.length
  console.log(chalk.bold(shown < totalSessions
    ? `SESSION HISTORY  (${shown} of ${totalSessions} sessions)`
    : `SESSION HISTORY  (${totalSessions} sessions)`))
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
