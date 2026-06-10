#!/usr/bin/env node
// CLI entry point. Registers all throughline commands with commander and
// delegates to command handlers in src/commands/index.ts.
import { Command } from 'commander'
import { cmdInit, cmdStart, cmdStatus, cmdDeviate, cmdDone, cmdNote, cmdResume, cmdRepair, cmdContinue, cmdHistory, cmdAttach } from './commands/index.js'

const program = new Command()

program
  .name('throughline')
  .description('Intent-first AI coding session tracker')
  .version('0.3.0')

program
  .command('init')
  .description('Initialize Throughline in the current repository')
  .option('--cwd <path>', 'Working directory')
  .option('-f, --force', 'Reinitialize if already initialized')
  .action((options) => cmdInit(options))

program
  .command('start <goal>')
  .description('Start a new intent-tracked session')
  .option('-a, --agent <agent>', 'AI agent to use (claude-code, opencode, gemini-cli)', 'claude-code')
  .option('--setup', 'Create session without spawning the agent (use with `attach`)')
  .option('--cwd <path>', 'Working directory')
  .option('--watch-depth <n>', 'File watcher directory depth (default 3)')
  .action((goal, options) => cmdStart(goal, options))

program
  .command('resume')
  .description('Resume the last session — same goal, carry over incomplete tasks')
  .option('-a, --agent <agent>', 'AI agent to use')
  .option('--cwd <path>', 'Working directory')
  .option('--watch-depth <n>', 'File watcher directory depth (default 3)')
  .action((options) => cmdResume(options))

program
  .command('repair')
  .description('Start a repair session — fix issues from the last session')
  .option('-a, --agent <agent>', 'AI agent to use')
  .option('--cwd <path>', 'Working directory')
  .option('--watch-depth <n>', 'File watcher directory depth (default 3)')
  .action((options) => cmdRepair(options))

program
  .command('continue <goal>')
  .description('Start a new session that continues from the last — new goal, inherited context')
  .option('-a, --agent <agent>', 'AI agent to use')
  .option('--cwd <path>', 'Working directory')
  .option('--watch-depth <n>', 'File watcher directory depth (default 3)')
  .action((goal, options) => cmdContinue(goal, options))

program
  .command('status')
  .description('Show current session intent graph')
  .option('--json', 'Output as JSON')
  .option('--cwd <path>', 'Working directory')
  .action((options) => cmdStatus(options))

program
  .command('attach')
  .description('Attach to an existing session without spawning an agent')
  .option('--cwd <path>', 'Working directory')
  .option('--watch-depth <n>', 'File watcher directory depth (default 3)')
  .action((options) => cmdAttach(options))

program
  .command('history')
  .description('Show all past sessions')
  .option('--json', 'Output as JSON')
  .option('-n, --limit <number>', 'Limit number of sessions shown')
  .option('--cwd <path>', 'Working directory')
  .action((options) => cmdHistory(options))

program
  .command('note <text>')
  .description('Record a decision or reasoning note in the current session')
  .option('-c, --category <category>', 'Note category (decision, context, feedback, insight)')
  .option('--cwd <path>', 'Working directory')
  .action((text, options) => cmdNote(text, options))

program
  .command('deviate <reason>')
  .description('Record a deviation from the current plan')
  .option('-s, --spawns <task>', 'Description of new task spawned by this deviation')
  .option('--cwd <path>', 'Working directory')
  .action((reason, options) => cmdDeviate(reason, options))

program
  .command('done')
  .description('Mark current step complete, or close the session')
  .option('--session', 'Close the entire session')
  .option('--abandon', 'Mark session as abandoned instead of complete')
  .option('--cwd <path>', 'Working directory')
  .action((options) => cmdDone(options))

program.parse()
