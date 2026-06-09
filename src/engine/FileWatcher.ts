import chokidar from 'chokidar'
import path from 'path'
import type { SessionStore } from './SessionStore.js'
import type { TaskTracker } from './TaskTracker.js'

const IGNORED = [
  /node_modules/,
  /\.git\//,
  /\.intent\//,
  /dist\//,
  /\.next\//,
  /\.cache\//,
]

export class FileWatcher {
  private watcher: chokidar.FSWatcher | null = null
  private store: SessionStore
  private tracker: TaskTracker
  private root: string
  private unplannedFiles: string[] = []
  private onUnplanned?: (file: string, plannedFiles: string[]) => void

  constructor(store: SessionStore, tracker: TaskTracker, root: string = process.cwd()) {
    this.store = store
    this.tracker = tracker
    this.root = root
  }

  start(onUnplanned?: (file: string, plannedFiles: string[]) => void): void {
    this.onUnplanned = onUnplanned

    this.watcher = chokidar.watch(this.root, {
      ignored: IGNORED,
      persistent: true,
      ignoreInitial: true,
      depth: 10,
    })

    this.watcher.on('change', (filePath) => this.handleChange(filePath))
    this.watcher.on('add', (filePath) => this.handleChange(filePath))
  }

  stop(): void {
    this.watcher?.close()
    this.watcher = null
  }

  getUnplannedFiles(): string[] {
    return this.unplannedFiles
  }

  clearUnplanned(): void {
    this.unplannedFiles = []
  }

  private handleChange(filePath: string): void {
    if (!this.store.hasActiveSession()) return

    const relative = path.relative(this.root, filePath)
    this.tracker.recordFileTouched(relative)

    // Check if this file was planned for the current step
    const currentStep = this.tracker.getCurrentStep()
    if (currentStep && currentStep.files.planned.length > 0) {
      if (!currentStep.files.planned.some(f => relative.includes(f) || f.includes(relative))) {
        if (!this.unplannedFiles.includes(relative)) {
          this.unplannedFiles.push(relative)
          this.onUnplanned?.(relative, currentStep.files.planned)
        }
      }
    }
  }
}
