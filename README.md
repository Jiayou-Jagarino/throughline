# Throughline

Intent-first AI coding session tracker. Throughline records what you and your AI agent are doing, why, and how each step connects to the goal — so you never lose the thread across sessions.

## Quickstart

```bash
# Install globally
npm install -g throughline

# Initialize in your project
throughline init

# Start a session with an AI agent
throughline start "Refactor auth module" --agent opencode

# Or create a session without launching an agent (use another terminal)
throughline start "Build dashboard" --setup
throughline attach

# Record progress
throughline note "Decided to use Zustand for state" --category decision
throughline deviate "API changed, need new approach" --spawns "Update integration tests"

# Check status
throughline status
throughline status --json

# Complete steps and close session
throughline done          # mark current step complete
throughline done --session  # close session

# Resume or continue previous sessions
throughline resume
throughline continue "New feature"
```

## Architecture

```
src/
├── index.ts                  # CLI entry point (Commander)
├── types.ts                  # Domain types (IntentGraph, TaskIntent, etc.)
├── commands/
│   └── index.ts              # All CLI command implementations
├── engine/
│   ├── SessionStore.ts       # YAML file CRUD for .intent/session.yml
│   ├── ContextBuilder.ts     # Builds [THROUGHLINE CONTEXT] blocks + context.txt
│   ├── TaskTracker.ts        # Task/step state transitions
│   ├── OpenCodeBridge.ts     # SSE client for OpenCode agent events
│   └── FileWatcher.ts        # Chokidar-based file change detection
├── session/
│   └── MarkerScanner.ts      # Parses [THROUGHLINE:...] markers from agent stdout
├── parsers/
│   └── deviationParser.ts    # Regex-based marker parsing + system prompt builder
├── mcp/
│   └── index.ts              # MCP server for throughline_get_context / throughline_status
└── utils/
    └── logger.ts             # Debug logging (THROUGHLINE_DEBUG=1)
```

### Data flow — wrap strategy (claude-code, gemini-cli)

1. `throughline start` creates a `SessionIntent` in `.intent/session.yml` (YAML)
2. Agent spawned as child process with system prompt containing `[THROUGHLINE CONTEXT]` block
3. Agent emits `[THROUGHLINE:PLAN]`, `[THROUGHLINE:STEP_DONE]`, `[THROUGHLINE:DEVIATE]`, `[THROUGHLINE:NOTE]` markers in stdout
4. `MarkerScanner` parses markers and triggers callbacks in `launchAgent()`
5. `ContextBuilder` writes `.intent/context.txt` after every event
6. `FileWatcher` detects unplanned file touches
7. Agent exit triggers session auto-close or prompts to close

### Data flow — OpenCode bridge strategy

1. `throughline start "goal" --agent opencode` creates a session, starts `opencode serve`
2. OpenCode bridge (`OpenCodeBridge.ts`) connects to SSE events at `/event`
3. SSE events carry tool calls (write, read, bash, todowrite) and text parts (markers)
4. Write tool events captured at `completed` phase — file touch recorded + persisted as session note
5. `[THROUGHLINE:PLAN]` in text parts creates tasks/steps in the intent graph
6. A terminal window opens with `opencode attach` — you interact with OpenCode normally
7. `context.txt` refreshes on every event (idle, file touch, marker, git op)
8. Close the OpenCode window when done — Throughline shows a post-session menu

### git auto-init

`throughline init` (and auto-init during `throughline start`) runs `git init` if the project directory has no `.git` folder. Already-initialized repos are skipped silently.

### Production hardening

| Safeguard | Mechanism |
|-----------|-----------|
| **Atomic YAML writes** | Writes to `session.yml.tmp` then `renameSync()` — on Windows the rename is atomic, so readers always see a complete file, never a half-written YAML |
| **Concurrent access lock** | `.intent/.session.lock` with `wx` flag (exclusive create). 30 retries × 50ms timeout. Stale locks older than 5s auto-cleared |
| **Disk-full handling** | Catches `ENOSPC` specifically and shows: `Disk full: cannot write session.yml. Free disk space and retry.` |
| **Corrupt file resilience** | `_readYamlFileSafe` skips corrupt history files with a logged warning instead of crashing |
| **File watcher depth** | Default 3 directory levels, configurable via `--watch-depth <n>`. Prevents deep scans on large monorepos |

## Commands

| Command | Description |
|---------|-------------|
| `init` | Initialize `.intent/` directory |
| `start <goal>` | Start a new session (optionally launch agent) |
| `resume` | Resume last session with incomplete tasks |
| `repair` | Start a repair session from last session context |
| `continue <goal>` | Start new session inheriting context from last |
| `status` | Show current session tree |
| `attach` | Watch a session from another terminal |
| `note <text>` | Record a decision or insight |
| `deviate <reason>` | Record a plan deviation |
| `done` | Mark step complete or close session |
| `history` | List past sessions |

### Options

| Flag | Commands |
|------|----------|
| `--cwd <path>` | All commands |
| `--json` | `status`, `history` |
| `-n, --limit N` | `history` |
| `-a, --agent <name>` | `start`, `resume`, `repair`, `continue` |
| `-c, --category <cat>` | `note` |
| `-s, --spawns <task>` | `deviate` |
| `--setup` | `start` (no agent launch) |
| `--watch-depth <n>` | `start`, `resume`, `repair`, `continue`, `attach` |
| `--session` | `done` (close entire session) |
| `--abandon` | `done` (mark abandoned) |
| `-f, --force` | `init` (reinitialize) |

## Agent markers

Agents emit these markers in their output. They are stripped from user-visible display.

| Marker | When | Purpose |
|--------|------|---------|
| `[THROUGHLINE:PLAN]...[/THROUGHLINE:PLAN]` | Before first action | Declare task/step plan (JSON) |
| `[THROUGHLINE:STEP_DONE]` | After completing a step | Advance to next step |
| `[THROUGHLINE:DEVIATE reason="..." spawns="..."]` | On unexpected discovery | Record plan deviation |
| `[THROUGHLINE:NOTE text="..." category="..."]` | For important context | Save decisions for future sessions |
| `[THROUGHLINE:CONTEXT_READ]` | After reading context.txt | Confirm agent saw latest state |

## MCP integration

Throughline ships with an MCP server for AI agent tools:

```json
{
  "mcpServers": {
    "throughline": {
      "command": "node",
      "args": ["path/to/throughline/dist/mcp/index.js", "--cwd", "."]
    }
  }
}
```

Tools:
- `throughline_get_context` — Get the current context block
- `throughline_status` — Get structured session status as JSON

## Development

```bash
git clone https://github.com/your-org/throughline
cd throughline
npm install
npm run build
npm test                    # 159 vitest tests
node test-context-file.mjs  # 36 integration tests (state machine + context.txt)
node test/e2e-mock-agent.mjs # 8 mock agent pipeline tests

# Watch mode
npm run test:watch
```

**Test totals: 203 tests** (159 vitest + 36 integration + 8 mock agent E2E).

Set `THROUGHLINE_DEBUG=1` for verbose debug logging.

## License

MIT
