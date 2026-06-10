# Throughline Domain Model

## Core Concepts

### SessionIntent
A single tracked AI coding session. Has a goal (declared by developer), an agent type, and a status lifecycle: `pending → in_progress → complete | abandoned`. Sessions can relate to previous sessions via `resume`, `repair`, or `continue` relations.

### TaskIntent
A unit of work within a session, declared by either the developer or the AI agent. Tasks contain ordered steps. Task status mirrors `SessionIntent` statuses. Tasks can depend on other tasks via `depends_on[]`.

### StepIntent
An atomic action within a task. Each step tracks:
- **planned files** — what the agent declared it would touch
- **touched files** — what actually changed (detected by FileWatcher)
- **deviation** — if the step went off-plan, the reason and any spawned task

### Deviation
Recorded when the agent discovers something mid-execution that changes the plan. Spawns an optional new task. Deviations are attached to the step where they occurred.

### Note
A developer or AI annotation saved to the session. Categories: `decision`, `context`, `feedback`, `insight`. Notes persist across sessions (carried forward on resume/repair/continue).

## File Layout

```
.intent/
├── session.yml           # Active session (YAML, gitignored)
├── context.txt           # Auto-refreshed context block for agent reads
├── context-audit.log     # All context writes and reads (append-only log)
├── spec.md               # Throughline specification
└── history/
    └── session-001.yml   # Archived sessions (closed/abandoned)
```

## State Machine

```
SessionIntent:  pending → in_progress → complete
                                       → abandoned
                  ↑ (resume/continue)

TaskIntent:     pending → in_progress → complete
                           → deviated → complete
                                      → abandoned

StepIntent:     pending → in_progress → complete
                           → deviated

Deviation:      recorded → spawned_task created
```

## Context Block Format

The `[THROUGHLINE CONTEXT]` block is the primary communication mechanism between Throughline and the AI agent. It includes:

1. Session goal and status
2. Parent session context (for resume/repair/continue)
3. Session notes
4. Completed tasks
5. Current task with completed/pending steps
6. Current step with planned files
7. Pending tasks
8. Deviation count

The agent reads this via `.intent/context.txt` (file) or `throughline_get_context` (MCP tool). After reading, it emits `[THROUGHLINE:CONTEXT_READ]` so Throughline can confirm the agent saw the latest state.

## Agent Strategies

Throughline supports two agent strategies:

### Wrap strategy (claude-code, gemini-cli)

- Spawns agent as child process, pipes stdio
- `MarkerScanner` parses `[THROUGHLINE:...]` markers from stdout
- File changes detected via `FileWatcher` (chokidar)
- Agent exit triggers session close or prompt

### OpenCode bridge strategy

- Starts `opencode serve` on port 4096
- `OpenCodeBridge.ts` connects to the SSE event stream at `GET /event`
- Events are `message.part.updated` with `part.type === "text"` (for markers) or `part.type === "tool"` (for tool calls)
- Tool events go through 3 phases: `pending → running → completed`; file writes are captured at `completed`
- Opens a terminal window with `opencode attach` for interactive use
- When the window closes, shows a post-session menu (status / done / keep open)

## SSE Event Routing

OpenCode does not emit `tool.execute.after` events. All agent tool activity arrives as:

| Event | `event.type` | `part.type` | What we do |
|-------|-------------|-------------|------------|
| Session created | `session.created` | — | Capture session ID, notify `onSessionCreated` |
| Agent idle | `session.idle` | — | Flush context.txt, sync todos |
| Agent idle (alt) | `session.status` | — | Same as `session.idle` |
| Markers (PLAN, etc.) | `message.part.updated` | `text` | Parse Throughline markers |
| File writes | `message.part.updated` | `tool` | Capture path at `completed` phase |
| Shell commands | `message.part.updated` | `tool` | Detect git ops and file writes |
| MCP queries | `message.part.updated` | `tool` | Log via `debug()`, no state change |
| Todo sync | `message.part.updated` | `tool` | Update local todo list |

## Read Detection

Reads are tracked from 4 sources:
- **mcp** — agent tool calls (precise, via `logContextRead('mcp')`)
- **agent** — `[THROUGHLINE:CONTEXT_READ]` marker in stdout (precise)
- **attach** — human terminal session (precise)
- **filesystem** — atime polling with mtime guard (fuzzy)
- **mcp-tool** — SSE-detected agent MCP calls (precise, via `handleToolEvent`)

The filesystem watcher uses atime changes to detect reads, with an mtime guard to exclude writes. On the target Windows system, `statSync` does not update atime — only `readFileSync` does.
