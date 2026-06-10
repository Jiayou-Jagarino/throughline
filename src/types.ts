// ─── Core domain types ───────────────────────────────────────────────────
// These types define the intent graph: a session contains tasks, tasks
// contain steps, steps track planned/touched files and deviations.

export type Status = 'pending' | 'in_progress' | 'complete' | 'abandoned' | 'deviated'
export type DeclaredBy = 'developer' | 'ai'
export type Agent = 'claude-code' | 'opencode' | 'gemini-cli' | 'other'
export type SessionRelation = 'resume' | 'repair' | 'continue'

export type NoteSource = 'developer' | 'ai'

export interface Note {
  text: string
  recorded_at: string
  source: NoteSource
  category?: string
}

export interface Deviation {
  reason: string
  spawned_task: string | null
  recorded_at: string
}

export interface StepIntent {
  id: string
  intent: string
  declared_by: DeclaredBy
  status: Status
  files: {
    planned: string[]
    touched: string[]
  }
  deviation: Deviation | null
  completed_at: string | null
}

export interface TaskIntent {
  id: string
  intent: string
  declared_by: DeclaredBy
  status: Status
  depends_on: string[]
  steps: StepIntent[]
}

export interface SessionIntent {
  id: string
  goal: string
  declared_by: 'developer'
  status: Status
  started_at: string
  closed_at: string | null
  agent: Agent
  parent_session: string | null
  relation: SessionRelation | null
  notes: Note[]
}

export interface IntentGraph {
  session: SessionIntent
  tasks: TaskIntent[]
}
