# Throughline

**Intent-first AI coding session tracker.**

Throughline records what was *meant* to happen, not just what changed. It wraps AI coding sessions with a planning stage, tracks execution against declared intent, and captures deviations as first-class data — so every new session resumes with full context.

---

## The problem

AI coding agents lose context between sessions. They see what changed (git diffs) but not *why* — what was planned, what was discovered mid-execution, what decisions were made. Every resumed session starts from zero.

## The solution

Throughline adds a `.intent/` directory alongside `.git/`. Before any code is touched, the AI declares its plan. During execution, file touches are tracked against that plan. Deviations spawn new tracked tasks instead of disappearing into the void. When a new session opens, the full intent graph is injected as context.

---

## Install

```bash
npm install -g throughline
```

---

## Quickstart

```bash
# In any git repo
throughline init

# Start a session — the AI plans before it codes
throughline start "add role-based access control to the API"

# See where you are
throughline status

# Mark current step done, advance to next
throughline done

# Record a deviation (manual)
throughline deviate "user model missing role field" --spawns "add role field to user model"

# Close the session when complete
throughline done --session
```

---

## How it works

### Three intent levels

```
SESSION INTENT     the goal. declared by developer. never changes.
  TASK INTENT      a logical chunk. declared by AI during planning.
    STEP INTENT    a single atomic action. declared by AI per task.
```

### The planning stage

When a session starts, the AI is instructed to output a structured plan before touching any files:

```
[THROUGHLINE:PLAN]
{ "tasks": [{ "intent": "...", "steps": [{ "intent": "...", "files": ["..."] }] }] }
[/THROUGHLINE:PLAN]
```

Throughline parses this and writes it to `.intent/session.yml`.

### Deviation tracking

When the AI discovers something that changes the plan, it outputs:

```
[THROUGHLINE:DEVIATE reason="user model missing role field" spawns="add role field to user model"]
```

Throughline records this, marks the current step as deviated, and spawns a new tracked task. Deviations are data, not errors.

### File watching

Throughline watches the filesystem during a session. If a file is touched that wasn't in the current step's plan, it flags it for the developer to resolve.

---

## The `.intent/` spec

The `.intent/` format is an **open standard**. Any tool can read and write it without depending on Throughline.

See [SPEC.md](./SPEC.md) for the full schema.

```
.intent/
  session.yml       ← active session (gitignored)
  history/
    session-001.yml ← archived completed sessions (committed)
  spec.md           ← the open spec
```

---

## Agent support

| Agent | Support |
|-------|---------|
| Claude Code | ✓ Full (stdout parsing + file watching) |
| OpenCode | ✓ Full |
| Gemini CLI | ✓ Full |
| Cursor / Windsurf | Planned (VS Code extension) |
| Any MCP-compatible agent | Planned (MCP server) |

---

## Roadmap

- **v0.1** — CLI wrapper with intent engine, deviation tracking, file watching ← *you are here*
- **v0.2** — MCP server (any agent reads/writes intent natively)
- **v0.3** — VS Code extension
- **v0.4** — Intent graph visualization

---

## Philosophy

- **Intent is primary.** The intent graph is the source of truth. Code is its artifact.
- **Deviations are data.** Every unexpected turn is recorded, never suppressed.
- **Tool-agnostic.** The `.intent` spec is open. Build on it.
- **Human-readable.** YAML, plain text. Works without tooling.
