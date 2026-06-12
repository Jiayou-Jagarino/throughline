// ─── Task state machine ──────────────────────────────────────────────────
// Manages the lifecycle of tasks and steps within a session. Tasks and steps
// progress through: pending → in_progress → complete (or → deviated).
// File touches are tracked per-step, and unassigned touches fall back to
// session-level notes.
// session-level notes.
import type { IntentGraph, TaskIntent, StepIntent, Deviation, Status } from '../types.js'
import { SessionStore } from './SessionStore.js'

export class TaskTracker {
  private store: SessionStore

  constructor(store: SessionStore) {
    this.store = store
  }

  // ─── Add tasks from a PLAN marker ────────────────────────────────────────
  addTasks(tasks: Omit<TaskIntent, 'id'>[]): IntentGraph {
    const graph = this.store.read()
    const startIdx = graph.tasks.length + 1
    const newTasks: TaskIntent[] = tasks.map((t, i) => ({
      ...t,
      id: `t${startIdx + i}`,
      steps: t.steps.map((s, j) => ({
        ...s,
        id: `t${startIdx + i}-s${j + 1}`,
      })),
    }))
    graph.tasks.push(...newTasks)
    graph.session.status = 'in_progress'
    this.store.write(graph)
    return graph
  }

  // ─── Mark a step complete; auto-close task/session if all done ───────────
  completeStep(taskId: string, stepId: string): IntentGraph {
    const graph = this.store.read()
    const task = graph.tasks.find(t => t.id === taskId)
    if (!task) throw new Error(`Task ${taskId} not found`)
    const step = task.steps.find(s => s.id === stepId)
    if (!step) throw new Error(`Step ${stepId} not found`)

    step.status = 'complete'
    step.completed_at = new Date().toISOString()

    const allStepsDone = task.steps.every(s => s.status === 'complete' || s.status === 'abandoned')
    if (allStepsDone) task.status = 'complete'

    const allTasksDone = graph.tasks.every(t => t.status === 'complete' || t.status === 'abandoned')
    if (allTasksDone) graph.session.status = 'complete'

    this.store.write(graph)
    return graph
  }

  // ─── Record a deviation on a task/step; optionally spawn a new task ─────
  recordDeviation(taskId: string, stepId: string, deviation: Deviation): IntentGraph {
    const graph = this.store.read()
    const task = graph.tasks.find(t => t.id === taskId)
    if (!task) throw new Error(`Task ${taskId} not found`)
    const step = task.steps.find(s => s.id === stepId)
    if (!step) throw new Error(`Step ${stepId} not found`)

    step.status = 'deviated'
    step.deviation = deviation
    task.status = 'deviated'

    if (deviation.spawned_task) {
      const spawnedTask: TaskIntent = {
        id: `t${graph.tasks.length + 1}`,
        intent: deviation.spawned_task,
        declared_by: 'ai',
        status: 'pending',
        depends_on: [taskId],
        steps: [],
      }
      deviation.spawned_task = spawnedTask.id
      graph.tasks.push(spawnedTask)
    }

    this.store.write(graph)
    return graph
  }

  // ─── Record a file touch on the active step; fall back to session note ──
  recordFileTouched(filePath: string): void {
    if (!this.store.hasActiveSession()) return
    const relative = normalizeToRelative(filePath, this.store.rootDir)
    const graph = this.store.read()

    for (const task of graph.tasks) {
      if (task.status !== 'in_progress' && task.status !== 'deviated') continue
      for (const step of task.steps) {
        if (step.status === 'in_progress' || step.status === 'pending') {
          if (!step.files.touched.includes(relative)) {
            step.files.touched.push(relative)
          }
          this.store.write(graph)
          return
        }
      }
    }

    // Fallback: no active task/step — deduplicate before adding note
    const noteText = `File touched (no active task): ${relative}`
    const alreadyNoted = graph.session.notes.some(
      n => n.category === 'context' && n.text === noteText
    )
    if (!alreadyNoted) {
      graph.session.notes.push({
        text: noteText,
        recorded_at: new Date().toISOString(),
        source: 'ai',
        category: 'context',
      })
      this.store.write(graph)
    }
  }

  setStepStatus(taskId: string, stepId: string, status: Status): void {
    const graph = this.store.read()
    const task = graph.tasks.find(t => t.id === taskId)
    if (!task) return
    const step = task.steps.find(s => s.id === stepId)
    if (!step) return
    step.status = status
    if (status === 'in_progress') task.status = 'in_progress'
    this.store.write(graph)
  }

  getCurrentTask(): TaskIntent | undefined {
    const graph = this.store.read()
    return graph.tasks.find(t => t.status === 'in_progress' || t.status === 'deviated')
  }

  getCurrentStep(): StepIntent | undefined {
    const task = this.getCurrentTask()
    return task?.steps.find(s => s.status === 'in_progress')
  }
}

// Normalize absolute or relative path to relative for consistent storage
function normalizeToRelative(filePath: string, rootDir: string): string {
  const normalized = filePath.replace(/\\/g, '/')
  const root = rootDir.replace(/\\/g, '/')
  if (normalized.startsWith(root)) {
    return normalized.slice(root.length).replace(/^\//, '')
  }
  return filePath.replace(/\\/g, '/')
}
