import { describe, it, expect } from 'vitest'
import {
  parseDeviationMarkers,
  parsePlanMarker,
  parseNoteMarkers,
  hasStepDoneMarker,
  stripMarkers,
} from '../src/parsers/deviationParser.js'

describe('parseDeviationMarkers', () => {
  it('parses deviation with reason and spawns', () => {
    const input = '[THROUGHLINE:DEVIATE reason="found bug" spawns="fix it"]'
    const result = parseDeviationMarkers(input)
    expect(result).toHaveLength(1)
    expect(result[0].reason).toBe('found bug')
    expect(result[0].spawns).toBe('fix it')
  })

  it('parses deviation with reason only', () => {
    const input = '[THROUGHLINE:DEVIATE reason="need refactor"]'
    const result = parseDeviationMarkers(input)
    expect(result).toHaveLength(1)
    expect(result[0].reason).toBe('need refactor')
    expect(result[0].spawns).toBeNull()
  })

  it('returns empty array for no markers', () => {
    expect(parseDeviationMarkers('normal output')).toEqual([])
  })

  it('finds multiple deviations', () => {
    const input = '[THROUGHLINE:DEVIATE reason="one"] [THROUGHLINE:DEVIATE reason="two"]'
    expect(parseDeviationMarkers(input)).toHaveLength(2)
  })

  it('skips malformed deviation markers', () => {
    const input = '[THROUGHLINE:DEVIATE something]'
    expect(parseDeviationMarkers(input)).toHaveLength(0)
  })

  it('handles quoted strings with special chars', () => {
    const input = '[THROUGHLINE:DEVIATE reason="path not found: /foo/bar"]'
    const result = parseDeviationMarkers(input)
    expect(result).toHaveLength(1)
    expect(result[0].reason).toBe('path not found: /foo/bar')
  })
})

describe('parsePlanMarker', () => {
  const validPlan = `[THROUGHLINE:PLAN]
{
  "tasks": [
    {
      "intent": "Add login",
      "steps": [
        { "intent": "Create LoginPage", "files": ["src/LoginPage.tsx"] }
      ]
    }
  ]
}[/THROUGHLINE:PLAN]`

  it('parses valid plan marker', () => {
    const result = parsePlanMarker(validPlan)
    expect(result).not.toBeNull()
    expect(result!.tasks).toHaveLength(1)
    expect(result!.tasks[0].intent).toBe('Add login')
    expect(result!.tasks[0].steps[0].files).toEqual(['src/LoginPage.tsx'])
  })

  it('returns null for no plan marker', () => {
    expect(parsePlanMarker('no plan')).toBeNull()
  })

  it('returns null for malformed JSON', () => {
    const input = '[THROUGHLINE:PLAN]{bad json}[/THROUGHLINE:PLAN]'
    expect(parsePlanMarker(input)).toBeNull()
  })

  it('works with extra whitespace', () => {
    const input = `[THROUGHLINE:PLAN]
  { "tasks": [] }
[/THROUGHLINE:PLAN]`
    const result = parsePlanMarker(input)
    expect(result).not.toBeNull()
    expect(result!.tasks).toEqual([])
  })
})

describe('parseNoteMarkers', () => {
  it('parses note with text and category', () => {
    const input = '[THROUGHLINE:NOTE text="remember this" category="decision"]'
    const result = parseNoteMarkers(input)
    expect(result).toHaveLength(1)
    expect(result[0].text).toBe('remember this')
    expect(result[0].category).toBe('decision')
  })

  it('parses note with text only', () => {
    const input = '[THROUGHLINE:NOTE text="just a note"]'
    const result = parseNoteMarkers(input)
    expect(result).toHaveLength(1)
    expect(result[0].text).toBe('just a note')
    expect(result[0].category).toBeUndefined()
  })

  it('skips note without text', () => {
    const input = '[THROUGHLINE:NOTE category="insight"]'
    expect(parseNoteMarkers(input)).toHaveLength(0)
  })

  it('finds multiple notes', () => {
    const input = '[THROUGHLINE:NOTE text="first"] [THROUGHLINE:NOTE text="second" category="feedback"]'
    const result = parseNoteMarkers(input)
    expect(result).toHaveLength(2)
    expect(result[0].text).toBe('first')
    expect(result[1].text).toBe('second')
    expect(result[1].category).toBe('feedback')
  })
})

describe('hasStepDoneMarker', () => {
  it('detects step done marker', () => {
    expect(hasStepDoneMarker('[THROUGHLINE:STEP_DONE]')).toBe(true)
  })

  it('detects step done in surrounding text', () => {
    expect(hasStepDoneMarker('done: [THROUGHLINE:STEP_DONE]')).toBe(true)
  })

  it('returns false without marker', () => {
    expect(hasStepDoneMarker('no marker')).toBe(false)
  })
})

describe('stripMarkers', () => {
  it('removes deviation markers', () => {
    const result = stripMarkers('Hello [THROUGHLINE:DEVIATE reason="test"] world')
    expect(result).toBe('Hello world')
  })

  it('removes plan markers', () => {
    const result = stripMarkers('plan [THROUGHLINE:PLAN]{}[/THROUGHLINE:PLAN] end')
    expect(result).toBe('plan end')
  })

  it('removes step done markers', () => {
    const result = stripMarkers('done [THROUGHLINE:STEP_DONE] now')
    expect(result).toBe('done now')
  })

  it('removes note markers', () => {
    const result = stripMarkers('note [THROUGHLINE:NOTE text="hi"] here')
    expect(result).toBe('note here')
  })

  it('removes context read markers', () => {
    const result = stripMarkers('read [THROUGHLINE:CONTEXT_READ] ok')
    expect(result).toBe('read ok')
  })

  it('strips all marker types in one pass', () => {
    const input = [
      '[THROUGHLINE:DEVIATE reason="x"]',
      '[THROUGHLINE:PLAN]{}[/THROUGHLINE:PLAN]',
      '[THROUGHLINE:STEP_DONE]',
      '[THROUGHLINE:NOTE text="y"]',
      '[THROUGHLINE:CONTEXT_READ]',
    ].join(' ')
    expect(stripMarkers(input)).toBe('')
  })

  it('normalizes extra whitespace', () => {
    expect(stripMarkers('a  b')).toBe('a b')
  })
})
