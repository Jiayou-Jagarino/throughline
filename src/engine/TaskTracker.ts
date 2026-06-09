import type { IntentGraph, TaskIntent, StepIntent, Deviation, Status } from '../types.js'
import { SessionStore } from './SessionStore.js'

export class TaskTracker {
  private store: SessionStore

  constructor(store: SessionStore) {
    this.store = store
  }

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

  recordFileTouched(filePath: string): void {
    if (!this.store.hasActiveSession()) return
    const graph = this.store.read()

    for (const task of graph.tasks) {
      if (task.status !== 'in_progress' && task.status !== 'deviated') continue
      for (const step of task.steps) {
        if (step.status === 'in_progress') {
          if (!step.files.touched.includes(filePath)) {
            step.files.touched.push(filePath)
          }
          this.store.write(graph)
          return
        }
      }
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
