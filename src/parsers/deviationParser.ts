// Parses [THROUGHLINE:DEVIATE ...] markers from AI agent stdout
// Format: [THROUGHLINE:DEVIATE reason="..." spawns="optional new task description"]

export interface DeviationMarker {
  reason: string
  spawns: string | null
}

export interface PlanMarker {
  tasks: Array<{
    intent: string
    steps: Array<{
      intent: string
      files: string[]
    }>
  }>
}

const DEVIATE_PATTERN = /\[THROUGHLINE:DEVIATE([^\]]*)\]/g
const PLAN_PATTERN = /\[THROUGHLINE:PLAN\]([\s\S]*?)\[\/THROUGHLINE:PLAN\]/
const STEP_DONE_PATTERN = /\[THROUGHLINE:STEP_DONE\]/g
const NOTE_PATTERN = /\[THROUGHLINE:NOTE([^\]]*)\]/g
const CONTEXT_READ_PATTERN = /\[THROUGHLINE:CONTEXT_READ\]/g

function parseAttributes(attrString: string): Record<string, string> {
  const attrs: Record<string, string> = {}
  const pattern = /(\w+)="([^"]*)"/g
  let match
  while ((match = pattern.exec(attrString)) !== null) {
    attrs[match[1]] = match[2]
  }
  return pattern.lastIndex = 0, attrs
}

export function parseDeviationMarkers(output: string): DeviationMarker[] {
  const markers: DeviationMarker[] = []
  const matches = output.matchAll(DEVIATE_PATTERN)
  for (const match of matches) {
    const attrs = parseAttributes(match[1])
    if (attrs.reason) {
      markers.push({
        reason: attrs.reason,
        spawns: attrs.spawns || null,
      })
    }
  }
  return markers
}

export function parsePlanMarker(output: string): PlanMarker | null {
  const match = PLAN_PATTERN.exec(output)
  if (!match) return null

  try {
    // The plan content is JSON inside the markers
    const parsed = JSON.parse(match[1].trim())
    return parsed as PlanMarker
  } catch {
    return null
  }
}

export interface NoteMarker {
  text: string
  category?: string
}

export function parseNoteMarkers(output: string): NoteMarker[] {
  const markers: NoteMarker[] = []
  const matches = output.matchAll(NOTE_PATTERN)
  for (const match of matches) {
    const attrs = parseAttributes(match[1])
    if (attrs.text) {
      markers.push({ text: attrs.text, category: attrs.category })
    }
  }
  return markers
}

export function hasStepDoneMarker(output: string): boolean {
  STEP_DONE_PATTERN.lastIndex = 0
  return STEP_DONE_PATTERN.test(output)
}

// Strips Throughline markers from output before displaying to developer
export function stripMarkers(output: string): string {
  return output
    .replace(DEVIATE_PATTERN, '')
    .replace(PLAN_PATTERN, '')
    .replace(STEP_DONE_PATTERN, '')
    .replace(NOTE_PATTERN, '')
    .replace(CONTEXT_READ_PATTERN, '')
    .trim()
}

// The system prompt injection that teaches the AI about Throughline markers
export function buildAgentSystemPrompt(contextBlock: string): string {
  return `${contextBlock}

---
You are operating inside a Throughline intent-tracking session.

RULES:
1. Before writing any code, output your plan using this exact format:
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

2. When you finish a step, output:
[THROUGHLINE:STEP_DONE]

3. If you discover something mid-execution that changes the plan, output:
[THROUGHLINE:DEVIATE reason="what you discovered" spawns="optional: description of new work required"]

4. To save important context, decisions, or user input for future sessions, output:
[THROUGHLINE:NOTE text="what's worth remembering" category="decision|context|feedback|insight"]

   Only note things that won't be obvious from the code later:
   · User expresses a preference or constraint ("avoid X", "prefer Y pattern")
   · A design decision was made and a specific path was rejected
   · Context that explains why code is the way it is
   · Feedback that changes direction

   Don't note: instructions (that's what tasks/steps are for), trivial chat, or code facts.

5. These markers are parsed automatically. Do not explain them to the user.
6. Before each response, read .intent/context.txt (it's refreshed after every event). After reading, emit:
   [THROUGHLINE:CONTEXT_READ]
   This is how Throughline knows you saw the latest context.
7. The session goal is your contract. Tasks and steps are your plan to fulfill it.
---`
}
