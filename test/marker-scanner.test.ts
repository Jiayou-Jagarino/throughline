import { describe, it, expect, vi } from 'vitest'
import { MarkerScanner } from '../src/session/MarkerScanner.js'

describe('MarkerScanner', () => {
  it('detects deviation markers', () => {
    const scanner = new MarkerScanner()
    const handler = vi.fn()
    scanner.onDeviationDetected(handler)
    scanner.feed('[THROUGHLINE:DEVIATE reason="found bug" spawns="fix"]')
    expect(handler).toHaveBeenCalledWith({ reason: 'found bug', spawns: 'fix' })
  })

  it('detects multiple deviations across feeds', () => {
    const scanner = new MarkerScanner()
    const handler = vi.fn()
    scanner.onDeviationDetected(handler)
    scanner.feed('[THROUGHLINE:DEVIATE reason="one"]')
    scanner.feed('[THROUGHLINE:DEVIATE reason="two"]')
    expect(handler).toHaveBeenCalledTimes(2)
    expect(handler).toHaveBeenCalledWith({ reason: 'one', spawns: null })
    expect(handler).toHaveBeenCalledWith({ reason: 'two', spawns: null })
  })

  it('tracks deviations incrementally across feeds', () => {
    const scanner = new MarkerScanner()
    const handler = vi.fn()
    scanner.onDeviationDetected(handler)
    scanner.feed('[THROUGHLINE:DEVIATE reason="x"]')
    scanner.feed('something else')
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('detects plan marker only once', () => {
    const scanner = new MarkerScanner()
    const handler = vi.fn()
    scanner.onPlanCaptured(handler)
    const plan = '[THROUGHLINE:PLAN]{"tasks":[]}[/THROUGHLINE:PLAN]'
    scanner.feed(plan)
    scanner.feed(plan)
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('emits plan event with parsed tasks', () => {
    const scanner = new MarkerScanner()
    const handler = vi.fn()
    scanner.onPlanCaptured(handler)
    scanner.feed('[THROUGHLINE:PLAN]{"tasks":[{"intent":"Build","steps":[{"intent":"Step 1","files":["a.ts"]}]}]}[/THROUGHLINE:PLAN]')
    expect(handler).toHaveBeenCalledWith({
      tasks: [{ intent: 'Build', steps: [{ intent: 'Step 1', files: ['a.ts'] }] }],
    })
  })

  it('detects step done markers across multiple feeds', () => {
    const scanner = new MarkerScanner()
    const handler = vi.fn()
    scanner.onStepDone(handler)
    scanner.feed('[THROUGHLINE:STEP_DONE]')
    expect(handler).toHaveBeenCalledTimes(1)
    scanner.feed('more output [THROUGHLINE:STEP_DONE]')
    expect(handler).toHaveBeenCalledTimes(2)
  })

  it('detects step done after other markers in buffer', () => {
    const scanner = new MarkerScanner()
    const handler = vi.fn()
    scanner.onStepDone(handler)
    scanner.feed('some work [THROUGHLINE:STEP_DONE] more text')
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('detects note markers', () => {
    const scanner = new MarkerScanner()
    const handler = vi.fn()
    scanner.onNote(handler)
    scanner.feed('[THROUGHLINE:NOTE text="remember" category="decision"]')
    expect(handler).toHaveBeenCalledWith({ text: 'remember', category: 'decision' })
  })

  it('detects notes without category', () => {
    const scanner = new MarkerScanner()
    const handler = vi.fn()
    scanner.onNote(handler)
    scanner.feed('[THROUGHLINE:NOTE text="hi"]')
    expect(handler).toHaveBeenCalledWith({ text: 'hi', category: undefined })
  })

  it('detects multiple notes incrementally', () => {
    const scanner = new MarkerScanner()
    const handler = vi.fn()
    scanner.onNote(handler)
    scanner.feed('[THROUGHLINE:NOTE text="first"] other text [THROUGHLINE:NOTE text="second"]')
    expect(handler).toHaveBeenCalledTimes(2)
  })

  it('detects context read marker', () => {
    const scanner = new MarkerScanner()
    const handler = vi.fn()
    scanner.onContextRead(handler)
    scanner.feed('[THROUGHLINE:CONTEXT_READ]')
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('handles CONTEXT_READ with whitespace', () => {
    const scanner = new MarkerScanner()
    const handler = vi.fn()
    scanner.onContextRead(handler)
    scanner.feed('[THROUGHLINE: CONTEXT_READ ]')
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('tracks context reads incrementally', () => {
    const scanner = new MarkerScanner()
    const handler = vi.fn()
    scanner.onContextRead(handler)
    scanner.feed('[THROUGHLINE:CONTEXT_READ]')
    scanner.feed('more output without marker')
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('emits once per context read marker', () => {
    const scanner = new MarkerScanner()
    const handler = vi.fn()
    scanner.onContextRead(handler)
    scanner.feed('[THROUGHLINE:CONTEXT_READ]')
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('strips ANSI codes before parsing', () => {
    const scanner = new MarkerScanner()
    const handler = vi.fn()
    scanner.onDeviationDetected(handler)
    scanner.feed('\x1b[32m[THROUGHLINE:DEVIATE reason="ok"]\x1b[0m')
    expect(handler).toHaveBeenCalledWith({ reason: 'ok', spawns: null })
  })

  it('accumulates data across feed calls', () => {
    const scanner = new MarkerScanner()
    const handler = vi.fn()
    scanner.onDeviationDetected(handler)
    scanner.feed('[THROUGHLINE:DEVIA')
    scanner.feed('TE reason="split"]')
    expect(handler).toHaveBeenCalledWith({ reason: 'split', spawns: null })
  })

  it('reset clears all state', () => {
    const scanner = new MarkerScanner()
    const handler = vi.fn()
    scanner.onDeviationDetected(handler)
    scanner.feed('[THROUGHLINE:DEVIATE reason="before"]')
    scanner.reset()
    scanner.feed('[THROUGHLINE:DEVIATE reason="after"]')
    expect(handler).toHaveBeenCalledTimes(2)
  })

  it('handles no registered handlers gracefully', () => {
    const scanner = new MarkerScanner()
    expect(() => {
      scanner.feed('[THROUGHLINE:DEVIATE reason="x"]')
      scanner.feed('[THROUGHLINE:PLAN]{}[/THROUGHLINE:PLAN]')
      scanner.feed('[THROUGHLINE:STEP_DONE]')
    }).not.toThrow()
  })

  it('ignores non-marker output', () => {
    const scanner = new MarkerScanner()
    const handler = vi.fn()
    scanner.onDeviationDetected(handler)
    scanner.onPlanCaptured(handler)
    scanner.onStepDone(handler)
    scanner.onNote(handler)
    scanner.onContextRead(handler)
    scanner.feed('Just a normal conversation with no markers at all')
    expect(handler).not.toHaveBeenCalled()
  })
})
