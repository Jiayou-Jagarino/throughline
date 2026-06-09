# Throughline — Agent Handoff

## Project State (v0.3.0)

Intent-first AI coding session tracker. CLI tool (`throughline`) that tracks what you and your AI agent are doing, why, and how each step connects to the goal.

**175 tests, all passing.** 131 vitest + 36 integration + 8 mock agent E2E.

## Commands

```
npm run build        # tsc
npm test             # vitest run
node test-context-file.mjs   # 36 integration tests
node test/e2e-mock-agent.mjs # 8 mock agent pipeline tests
```

## Key Files

- `src/engine/SessionStore.ts` — YAML CRUD with atomic writes + file lock
- `src/commands/index.ts` — All CLI commands
- `src/index.ts` — Commander entry point
- `docs/upgrade-report.md` — Full upgrade history from v0.1.1
- `docs/CONTEXT.md` — Domain model documentation

## To Publish to npm

When ready to publish, do the following:

### 1. Add `prepublishOnly` script

```json
"scripts": {
  "prepublishOnly": "npm run build && npm test"
}
```

### 2. Add package metadata

```json
{
  "license": "MIT",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/your-org/throughline.git"
  },
  "keywords": ["ai", "intent", "session", "tracking", "cli", "coding"],
  "files": ["dist/", "README.md", "LICENSE", "SPEC.md"]
}
```

### 3. Version bump

```
npm version patch    # 0.3.0 → 0.3.1 (or minor: 0.4.0)
```

### 4. Publish

```
npm publish
```

Requires `npm login` first if not already authenticated. The package name is `throughline`.

## Build Notes

- ESM module (`"type": "module"`)
- Windows-only (Node 18+)
- C: drive was full during development — all npm operations used `D:\throughline`
- Install locally via `npm install -g D:\throughline`
- `node-pty` was removed — `child_process.spawn()` with pipe stdio is used for agent launch (stdin-forwarding works, output is raw through the pipe)
