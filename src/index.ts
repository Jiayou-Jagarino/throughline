#!/usr/bin/env node
import { Command } from 'commander'
import { cmdInit, cmdStart, cmdStatus, cmdDeviate, cmdDone, cmdNote, cmdResume, cmdRepair, cmdContinue, cmdHistory, cmdAttach } from './commands/index.js'

const program = new Command()

program
  .name('throughline')
  .description('Intent-first AI coding session tracker')
  .version('0.2.0')

program
  .command('init')
  .description('Initialize Throughline in the current repository')
  .action(() => cmdInit())

program
  .command('start <goal>')
  .description('Start a new intent-tracked session')
  .option('-a, --agent <agent>', 'AI agent to use (claude-code, opencode, gemini-cli)', 'claude-code')
  .option('--setup', 'Create session without spawning the agent (use with `attach`)')
  .action((goal, options) => cmdStart(goal, options))

program
  .command('resume')
  .description('Resume the last session — same goal, carry over incomplete tasks')
  .option('-a, --agent <agent>', 'AI agent to use')
  .action((options) => cmdResume(options))

program
  .command('repair')
  .description('Start a repair session — fix issues from the last session')
  .option('-a, --agent <agent>', 'AI agent to use')
  .action((options) => cmdRepair(options))

program
  .command('continue <goal>')
  .description('Start a new session that continues from the last — new goal, inherited context')
  .option('-a, --agent <agent>', 'AI agent to use')
  .action((goal, options) => cmdContinue(goal, options))

program
  .command('status')
  .description('Show current session intent graph')
  .action(() => cmdStatus())

program
  .command('attach')
  .description('Attach to an existing session without spawning an agent')
  .action(() => cmdAttach())

program
  .command('history')
  .description('Show all past sessions')
  .action(() => cmdHistory())

program
  .command('note <text>')
  .description('Record a decision or reasoning note in the current session')
  .option('-c, --category <category>', 'Note category (decision, context, feedback, insight)')
  .action((text, options) => cmdNote(text, options))

program
  .command('deviate <reason>')
  .description('Record a deviation from the current plan')
  .option('-s, --spawns <task>', 'Description of new task spawned by this deviation')
  .action((reason, options) => cmdDeviate(reason, options))

program
  .command('done')
  .description('Mark current step complete, or close the session')
  .option('--session', 'Close the entire session')
  .option('--abandon', 'Mark session as abandoned instead of complete')
  .action((options) => cmdDone(options))

program.parse()
