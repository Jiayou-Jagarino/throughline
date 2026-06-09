#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import * as z from 'zod/v4'
import { SessionStore } from '../engine/SessionStore.js'
import { TaskTracker } from '../engine/TaskTracker.js'
import { ContextBuilder } from '../engine/ContextBuilder.js'

function parseArgs(): { cwd: string } {
  const cwdIdx = process.argv.indexOf('--cwd')
  const cwd = cwdIdx !== -1 && process.argv[cwdIdx + 1] ? process.argv[cwdIdx + 1] : process.cwd()
  return { cwd }
}

const { cwd } = parseArgs()
const store = new SessionStore(cwd)
const tracker = new TaskTracker(store)
const contextBuilder = new ContextBuilder(store)

const server = new McpServer({
  name: 'throughline',
  version: '0.2.0',
  description: 'Intent-first AI coding session tracker — context and status',
})

server.registerTool(
  'throughline_get_context',
  {
    description: 'Get the current session context block for injecting into AI agent prompts. Returns a formatted [THROUGHLINE CONTEXT] block with session goal, task tree, current step, and optional parent session context.',
    inputSchema: z.object({
      include_parent: z.boolean().optional().default(false).describe('Include parent session context when this is a resume/repair/continue session'),
    }),
  },
  async ({ include_parent }) => {
    try {
      if (!store.isInitialized()) {
        return {
          content: [{ type: 'text', text: 'Throughline not initialized. Run `throughline init` first.' }],
          isError: true,
        }
      }

      if (!store.hasActiveSession()) {
        return {
          content: [{ type: 'text', text: 'No active session. Start one with `throughline start "goal"`.' }],
          isError: true,
        }
      }

      let parentGraph = undefined
      if (include_parent) {
        const graph = store.read()
        if (graph.session.parent_session) {
          parentGraph = store.getSessionById(graph.session.parent_session) ?? undefined
        }
      }

      const context = contextBuilder.buildContextBlock(parentGraph)
      contextBuilder.logContextRead('mcp')
      return {
        content: [{ type: 'text', text: context }],
      }
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      }
    }
  },
)

server.registerTool(
  'throughline_status',
  {
    description: 'Get the current session status as structured JSON. Returns session info, current task/step, task tree, notes, and deviations.',
    inputSchema: z.object({}),
  },
  async () => {
    try {
      if (!store.isInitialized()) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: 'Not initialized. Run `throughline init` first.' }) }],
          isError: true,
        }
      }

      if (!store.hasActiveSession()) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: 'No active session' }) }],
          isError: true,
        }
      }

      const graph = store.read()
      const currentTask = tracker.getCurrentTask()
      const currentStep = tracker.getCurrentStep()

      const status = {
        session: {
          id: graph.session.id,
          goal: graph.session.goal,
          status: graph.session.status,
          agent: graph.session.agent,
          started_at: graph.session.started_at,
          closed_at: graph.session.closed_at,
          relation: graph.session.relation,
          parent_session: graph.session.parent_session,
          notes: graph.session.notes,
        },
        current_task: currentTask ? {
          id: currentTask.id,
          intent: currentTask.intent,
          status: currentTask.status,
          depends_on: currentTask.depends_on,
        } : null,
        current_step: currentStep ? {
          id: currentStep.id,
          intent: currentStep.intent,
          status: currentStep.status,
          files: currentStep.files,
          deviation: currentStep.deviation,
        } : null,
        tasks: graph.tasks.map(t => ({
          id: t.id,
          intent: t.intent,
          status: t.status,
          steps: t.steps.map(s => ({
            id: s.id,
            intent: s.intent,
            status: s.status,
            completed_at: s.completed_at,
            deviation: s.deviation,
          })),
        })),
        summary: {
          total_tasks: graph.tasks.length,
          completed: graph.tasks.filter(t => t.status === 'complete').length,
          in_progress: graph.tasks.filter(t => t.status === 'in_progress').length,
          pending: graph.tasks.filter(t => t.status === 'pending').length,
          deviated: graph.tasks.filter(t => t.status === 'deviated').length,
          abandoned: graph.tasks.filter(t => t.status === 'abandoned').length,
          deviations: graph.tasks.flatMap(t => t.steps.filter(s => s.deviation)).length,
          notes: graph.session.notes.length,
        },
      }

      contextBuilder.logContextRead('mcp')
      return {
        content: [{ type: 'text', text: JSON.stringify(status, null, 2) }],
      }
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      }
    }
  },
)

async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)
}

main().catch((err) => {
  console.error('MCP server error:', err)
  process.exit(1)
})
