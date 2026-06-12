// ─── MCP server ──────────────────────────────────────────────────────────
// Exposes Throughline session data to AI agents via the Model Context
// Protocol (stdio transport). Agents call throughline_get_context and
// throughline_status to read current session state.
//
// This is consumed by the agent's MCP runtime when running in OpenCode
// mode (the bridge detects these calls via SSE tool events).
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
  version: '0.3.0',
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

server.registerTool(
  'throughline_record_deviation',
  {
    description: 'Record a deviation on the current step — use when something unexpected changes the plan mid-execution. Stores the reason, optionally spawns a new task.',
    inputSchema: z.object({
      reason: z.string().min(1).describe('What went wrong or changed — be specific'),
      spawns: z.string().optional().describe('Description of a new task spawned by this deviation, if any'),
    }),
  },
  async ({ reason, spawns }) => {
    try {
      if (!store.hasActiveSession()) {
        return { content: [{ type: 'text', text: 'No active session.' }], isError: true }
      }

      const currentTask = tracker.getCurrentTask()
      const currentStep = tracker.getCurrentStep()
      if (!currentTask || !currentStep) {
        return { content: [{ type: 'text', text: 'No active task/step to deviate from.' }], isError: true }
      }

      tracker.recordDeviation(currentTask.id, currentStep.id, {
        reason,
        spawned_task: spawns || null,
        recorded_at: new Date().toISOString(),
      })
      contextBuilder.writeContextFile('deviation')

      return {
        content: [{ type: 'text', text: `Deviation recorded on step "${currentStep.intent}": ${reason}` }],
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
  'throughline_record_note',
  {
    description: 'Record a session note with optional category (decision, context, insight, instruction, feedback). Use for capturing decisions, insights, and important context that future sessions should know about.',
    inputSchema: z.object({
      text: z.string().min(1).describe('The note content'),
      category: z.enum(['decision', 'context', 'insight', 'instruction', 'feedback']).optional().default('context').describe('Category tag for the note'),
    }),
  },
  async ({ text, category }) => {
    try {
      if (!store.hasActiveSession()) {
        return { content: [{ type: 'text', text: 'No active session.' }], isError: true }
      }

      store.addNote(text, 'ai', category)
      contextBuilder.writeContextFile('note')

      return {
        content: [{ type: 'text', text: `Note recorded: ${text}` }],
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
  'throughline_step_done',
  {
    description: 'Mark the current step as complete and advance to the next pending step. Call this when you finish implementing a step in the plan.',
    inputSchema: z.object({}),
  },
  async () => {
    try {
      if (!store.hasActiveSession()) {
        return { content: [{ type: 'text', text: 'No active session.' }], isError: true }
      }

      const currentTask = tracker.getCurrentTask()
      const currentStep = tracker.getCurrentStep()
      if (!currentTask || !currentStep) {
        return { content: [{ type: 'text', text: 'No active step to complete.' }], isError: true }
      }

      const stepIntent = currentStep.intent
      tracker.completeStep(currentTask.id, currentStep.id)
      contextBuilder.writeContextFile('step-done')

      const graph = store.read()
      const task = graph.tasks.find(t => t.id === currentTask.id)!
      const nextStep = task.steps.find(s => s.status === 'pending')

      let result = `Step completed: "${stepIntent}"`
      if (nextStep) {
        tracker.setStepStatus(task.id, nextStep.id, 'in_progress')
        contextBuilder.writeContextFile('step-advance')
        result += `\nAdvanced to next step: "${nextStep.intent}"`
      } else {
        const allDone = task.steps.every(s => s.status === 'complete' || s.status === 'abandoned')
        if (allDone) result += '\nAll steps complete — task finished.'
      }

      return {
        content: [{ type: 'text', text: result }],
      }
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      }
    }
  },
)

// ─── Main ────────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)
}

main().catch((err) => {
  console.error('MCP server error:', err)
  process.exit(1)
})
