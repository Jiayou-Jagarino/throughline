# The Throughline Intent Spec
**Version 0.1.1**

## Overview

The `.intent/` directory is an open standard for recording developer and AI intent during coding sessions. It sits alongside `.git/` and tracks *what was meant to happen*, not just what changed.

Any tool can read and write this format. No dependency on Throughline CLI required.

---

## Directory Structure

```
.intent/
  session.yml         ← active session intent graph (gitignored)
  history/
    session-001.yml   ← archived completed sessions (committed)
    session-002.yml
  spec.md             ← copy of this spec (for offline reference)
```

---

## session.yml Schema

```yaml
# ─── Session ───────────────────────────────────────────────────────────────
session:
  id: string                  # unique session identifier (e.g. "session-003")
  goal: string                # developer-declared goal in natural language
  declared_by: developer      # always "developer" at session level
  status: pending|in_progress|complete|abandoned
  started_at: ISO8601
  closed_at: ISO8601|null
  agent: string               # e.g. "claude-code", "opencode", "gemini-cli"
  parent_session: string|null # session id this resumes/repairs/continues
  relation: resume|repair|continue|null  # how this session relates to parent
  notes:                      # inline decisions and reasoning captured during session
    - text: string
      recorded_at: ISO8601

# ─── Tasks ─────────────────────────────────────────────────────────────────
tasks:
  - id: string                # e.g. "t1", "t2"
    intent: string            # what this task achieves
    declared_by: ai|developer
    status: pending|in_progress|complete|abandoned|deviated
    depends_on: string[]      # task ids this depends on
    steps:
      - id: string            # e.g. "t1-s1"
        intent: string        # single atomic action
        declared_by: ai|developer
        status: pending|in_progress|complete|deviated
        files:
          planned: string[]   # files the AI declared it would touch
          touched: string[]   # files actually touched (populated by watcher)
        deviation: null|
          reason: string      # why the plan changed
          spawned_task: string|null  # task id spawned from this deviation
          recorded_at: ISO8601
        completed_at: ISO8601|null
```

---

## Intent Levels

```
SESSION INTENT     the goal. set once by developer. never changes mid-session.
  TASK INTENT      a logical chunk of work. declared by AI during planning.
    STEP INTENT    a single atomic action. declared by AI per task.
```

The session intent is the contract.
Task and step intents are the plan to fulfill that contract.
Deviations are amendments to the plan — not violations of the contract.

---

## Session Relations

Sessions can relate to previous sessions, forming a chain of context:

| Relation | Meaning |
|----------|---------|
| `resume` | Same goal, incomplete tasks carried over, context injected |
| `repair` | New session to fix issues from the previous session |
| `continue` | New goal, previous session's context injected as background |

When a session has a `parent_session`, tools should inject the parent's completed tasks, deviations, and notes into the AI's context at session start.

---

## Deviation Model

A deviation is **not an error** — it is recorded information. When a step encounters something that changes the plan:

1. The step status becomes `deviated`
2. A `deviation.reason` is recorded
3. If new work is required, a new task is spawned and `deviation.spawned_task` points to it
4. The spawned task inherits the session goal but has its own task/step structure

Deviations propagate upward: a deviated step marks its parent task as `deviated`. A deviated task does not automatically abandon the session — the session continues with the spawned task inserted into the graph.

---

## Notes

Notes capture reasoning, decisions, and consulting outcomes inline during a session:

```yaml
notes:
  - text: "decided against SVG export — memory overhead too high on large canvases"
    recorded_at: "2026-06-09T10:30:00Z"
```

Notes are injected into context when a child session references this session via `parent_session`. This is how consulting and reasoning moments survive across sessions.

---

## Context Injection Format

When starting or resuming a session, tools inject the intent graph using this format:

```
[THROUGHLINE CONTEXT]
Session goal: <goal>
Status: <status>
Relation: <relation> of <parent_session_id>   (if applicable)

Previous session (<parent_id>): "<parent_goal>"   (if applicable)
Completed in previous session:
  ✓ <task intent>
Deviations from previous session:
  ⚡ <deviation reason>
Notes from previous session:
  · <note text>

Session notes:
  · <note text>

Completed tasks:
  ✓ <task intent>

Current task: <intent> (<id>)
  Completed steps:
    ✓ <step intent>
  Current step: <intent> (<id>)
  Planned files: <file list>
  Pending steps:
    · <step intent>

Pending tasks:
  · <task intent>

Deviations recorded: <count>
[/THROUGHLINE CONTEXT]
```

---

## Agent Markers

### Plan marker — AI declares intent before touching anything

```
[THROUGHLINE:PLAN]
{
  "tasks": [
    {
      "intent": "description of what this task achieves",
      "steps": [
        { "intent": "single atomic action", "files": ["path/to/file.ts"] }
      ]
    }
  ]
}
[/THROUGHLINE:PLAN]
```

### Deviation marker — AI flags a plan change mid-execution

```
[THROUGHLINE:DEVIATE reason="what was discovered" spawns="optional: new task description"]
```

Both markers are parsed automatically by Throughline-compatible tools and stripped from output shown to the developer.

---

## Principles

- **Intent is primary.** The intent graph is the source of truth for a session. Code changes are its artifact.
- **Deviations are data.** Every unexpected turn is recorded, never suppressed.
- **Notes are memory.** Decisions and reasoning captured inline survive into future sessions.
- **Sessions form chains.** Resume, repair, and continue create traceable lineage across sessions.
- **Tool-agnostic.** Any agent, any IDE, any language can read and write this format.
- **Human-readable.** YAML, plain text, no binary formats. Works without tooling.
