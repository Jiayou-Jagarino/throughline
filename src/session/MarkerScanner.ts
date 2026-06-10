// ─── Marker scanner ──────────────────────────────────────────────────────
// Buffers streaming agent stdout, strips ANSI codes, and dispatches
// Throughline markers (PLAN, STEP_DONE, DEVIATE, NOTE, CONTEXT_READ) via
// callbacks. Used in the "wrap" strategy where throughline pipes the
// agent's stdio (claude-code, gemini-cli).
//
// Differs from OpenCodeBridge's SSE approach: this is text-based scanning
// of raw terminal output, while the bridge parses structured SSE events.
import { parseDeviationMarkers, parsePlanMarker, parseNoteMarkers } from '../parsers/deviationParser.js'

export interface DeviationEvent {
  reason: string
  spawns: string | null
}

export interface PlanEvent {
  tasks: Array<{
    intent: string
    steps: Array<{
      intent: string
      files: string[]
    }>
  }>
}

export interface NoteEvent {
  text: string
  category?: string
}

export class MarkerScanner {
  private buffer = ''
  private lastDeviationCount = 0
  private planCaptured = false
  private stepDoneCount = 0
  private lastNoteCount = 0
  private contextReadCount = 0
  private _onDeviation?: (event: DeviationEvent) => void
  private _onPlan?: (event: PlanEvent) => void
  private _onStepDone?: () => void
  private _onNote?: (event: NoteEvent) => void
  private _onContextRead?: () => void

  onDeviationDetected(handler: (event: DeviationEvent) => void): void {
    this._onDeviation = handler
  }

  onPlanCaptured(handler: (event: PlanEvent) => void): void {
    this._onPlan = handler
  }

  onStepDone(handler: () => void): void {
    this._onStepDone = handler
  }

  onNote(handler: (event: NoteEvent) => void): void {
    this._onNote = handler
  }

  onContextRead(handler: () => void): void {
    this._onContextRead = handler
  }

  feed(data: string): void {
    this.buffer += data

    const clean = this.buffer
      .replace(/\x1b\[[\d;?]*[A-Za-z]/g, '')
      .replace(/\x1b\][^\x07]*\x07/g, '')

    const deviations = parseDeviationMarkers(clean)
    for (let i = this.lastDeviationCount; i < deviations.length; i++) {
      this._onDeviation?.({
        reason: deviations[i].reason,
        spawns: deviations[i].spawns,
      })
    }
    this.lastDeviationCount = deviations.length

    if (!this.planCaptured) {
      const plan = parsePlanMarker(clean)
      if (plan) {
        this.planCaptured = true
        this._onPlan?.({
          tasks: plan.tasks,
        })
      }
    }

    const stepDoneMatches = clean.match(/\[THROUGHLINE:STEP_DONE\]/g)
    const matchCount = stepDoneMatches ? stepDoneMatches.length : 0
    if (matchCount > this.stepDoneCount) {
      this.stepDoneCount = matchCount
      this._onStepDone?.()
    }

    const notes = parseNoteMarkers(clean)
    for (let i = this.lastNoteCount; i < notes.length; i++) {
      this._onNote?.({
        text: notes[i].text,
        category: notes[i].category,
      })
    }
    this.lastNoteCount = notes.length

    const CONTEXT_READ_RE = /\[THROUGHLINE:\s*CONTEXT_READ\s*\]/
    if (CONTEXT_READ_RE.test(clean)) {
      const matches = clean.match(new RegExp(CONTEXT_READ_RE.source, 'g'))!
      if (matches.length > this.contextReadCount) {
        this._onContextRead?.()
        this.contextReadCount = matches.length
      }
    }
  }

  reset(): void {
    this.buffer = ''
    this.lastDeviationCount = 0
    this.planCaptured = false
    this.stepDoneCount = 0
    this.lastNoteCount = 0
    this.contextReadCount = 0
  }
}
