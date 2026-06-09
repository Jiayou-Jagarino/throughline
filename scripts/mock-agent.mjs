#!/usr/bin/env node
// Mock AI agent for E2E testing.
// Outputs Throughline markers to simulate agent behavior.
const markers = [
  `[THROUGHLINE:PLAN]{"tasks":[{"intent":"Mock task","steps":[{"intent":"Mock step","files":["test.txt"]}]}]}[/THROUGHLINE:PLAN]`,
  `[THROUGHLINE:STEP_DONE]`,
  `[THROUGHLINE:NOTE text="test note from agent" category="decision"]`,
  `[THROUGHLINE:CONTEXT_READ]`,
]

// Simulate agent thinking time
for (const marker of markers) {
  process.stdout.write(marker + '\n')
  await new Promise(r => setTimeout(r, 50))
}
