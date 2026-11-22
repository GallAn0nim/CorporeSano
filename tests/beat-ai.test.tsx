import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { Workout } from '../types'
import {
  DEFAULT_SETTINGS,
  EMPTY_LAST,
  completedSets,
  endWorkout,
  localDate,
  nextBeatAiIndex,
  scoreText,
  setPhase,
  startBeatAi,
  stepBeatAi,
} from '../hooks/logic'
import { FIXTURE } from './fixtures/exercises'

const MIN = 60_000
const T0 = new Date(2026, 2, 10, 9, 0, 0).getTime()
const S = { ...DEFAULT_SETTINGS, level: 'beat-ai' as const }
const rng = () => 0
const match = (isClaudeDone = false, beatAiIndex = 0): Workout =>
  startBeatAi(S, FIXTURE.beatAi, { ...EMPTY_LAST, beatAiIndex }, T0, rng, isClaudeDone)!

describe('beat-ai logic', () => {
  test('a match starts where the last one stopped', async () => {
    expect(match(false, 0).exerciseIds).toEqual(['push-ups'])
    expect(match(false, 2).exerciseIds).toEqual(['plank'])
    expect(match(false, 4).exerciseIds).toEqual(['squats'])
  })
  test('40 s work, 20 s rest, then the next set in rotation', async () => {
    const w = match()
    expect(setPhase(w, T0 + 10_000)).toEqual({ phase: 'work', remainingMs: 30_000 })
    expect(setPhase(w, T0 + 45_000)).toEqual({ phase: 'rest', remainingMs: 15_000 })
    expect(stepBeatAi(w, T0 + 45_000)).toBe(null)
    const next = stepBeatAi(w, T0 + 60_000)
    expect(next && 'workout' in next && next.workout.exerciseIds).toEqual(['push-ups', 'squats'])
    expect(next && 'workout' in next && next.workout.exerciseStartedAt).toBe(T0 + 60_000)
  })
  test('the rotation wraps around', async () => {
    let w = match(false, 2)
    const ids: string[] = []
    for (let i = 0; i < 4; i++) {
      ids.push(w.exerciseIds[w.index]!)
      const r = stepBeatAi(w, w.exerciseStartedAt + 60_000)
      if (r && 'workout' in r) w = r.workout
    }
    expect(ids).toEqual(['plank', 'push-ups', 'squats', 'plank'])
  })
  test('once Claude is done the current set still finishes, then the match ends', async () => {
    const w = { ...match(), isClaudeDone: true }
    expect(stepBeatAi(w, T0 + 39_000)).toBe(null)
    expect(stepBeatAi(w, T0 + 40_000)).toEqual({ finished: true, sets: 1 })
  })
  test('score and stats', async () => {
    const w = { ...match(), index: 3, exerciseStartedAt: T0 + 3 * MIN }
    expect(completedSets(w, T0 + 3 * MIN + 10_000)).toBe(3)
    expect(completedSets(w, T0 + 3 * MIN + 41_000)).toBe(4)
    expect(scoreText(4, 'finished')).toBe('You 4 : 0 Claude')
    expect(scoreText(4, 'skipped')).toBe('You 0 : 1 Claude')
    const day = { v: 1 as const, date: localDate(T0), workStart: T0, beaten: 1, failed: 0 }
    const end = endWorkout(day, w, 'finished', T0 + 3 * MIN + 41_000)
    expect(end.beaten).toBe(5)
    expect(end.lastScore).toBe('You 4 : 0 Claude')
    expect(endWorkout(day, w, 'skipped', T0 + 3 * MIN + 10_000).lastScore).toBe('You 0 : 1 Claude')
    expect(nextBeatAiIndex({ ...w, pointer: 2 })).toBe(3)
  })
})

const BAR = {
  plugin: 'corpore-sano',
  component: 'AbovePrompt',
  surface: 'desktop',
  props: {
    hasSurvey: false,
    isCollapsed: false,
    isWorking: true,
    maxRows: 8,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 8 },
    view: {},
  },
} as const

function world(on: On, now: number, store: Record<string, unknown>) {
  const clock = mock.clock(on, { now })
  mock.store(on, store)
  const toasts: string[] = []
  on('command.register', () => ({ value: { command: 'corpore-sano' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('fs.read', () => ({ value: JSON.stringify(FIXTURE) }))
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.render', ($, e) => $.ui.resolve(e).Text({ children: '' }))
  return { clock, toasts }
}

type Ui = { find: (q: { type: 'Text'; text: RegExp }) => Promise<{ text?: string } | undefined> }
const text = async (ui: Ui, re: RegExp) => (await ui.find({ type: 'Text', text: re }))?.text
const day = { v: 1, date: localDate(T0), workStart: T0 - 46 * MIN, beaten: 0, failed: 0 }

test('the bar: sets, rest with the next exercise, score', async ($, on) => {
  const { clock } = world(on, T0, { 'cs.day': day, 'cs.workout': match() })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount(BAR)

  expect(await text(ui, /^Beat AI$/)).toBe('Beat AI')
  expect(await text(ui, /^push ups$/)).toBe('push ups')
  expect(await text(ui, /^Set /)).toBe('Set 1 · You 0 : 0 Claude')
  expect(await text(ui, /^0:40$/)).toBe('0:40')

  await clock.advance(40_000)
  expect(await text(ui, /^Rest/)).toBe('Rest · next: squats')
  expect(await text(ui, /^Set /)).toBe('Set 1 · You 1 : 0 Claude')
  expect(await text(ui, /^0:20$/)).toBe('0:20')

  await clock.advance(20_000)
  expect(await text(ui, /^squats$/)).toBe('squats')
  expect(await text(ui, /^Set /)).toBe('Set 2 · You 1 : 0 Claude')
  await ui.unmount()
})

test('Claude done: the set finishes, the match ends with the score', async ($, on) => {
  const { clock, toasts } = world(on, T0, { 'cs.day': day, 'cs.workout': { ...match(), isClaudeDone: true } })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount(BAR)
  expect(await text(ui, /^Last set$/)).toBe('Last set')

  await clock.advance(40_000)
  expect(await text(ui, /^Set /)).toBe(undefined)
  expect(toasts).toContain('Corpore Sano: You 1 : 0 Claude. You beat AI.')
  await ui.unmount()
})

describe('the match belongs to its session', () => {
  const turnEnd = { answer: '', durationMs: 1000, isAborted: false, turnId: 't1', reason: 'answer' as const }

  test('a turn ending in another session does not end the match', async ($, on) => {
    const { clock } = world(on, T0, { 'cs.day': day, 'cs.workout': { ...match(), sessionId: 'session-a' } })
    on('session.id', () => ({ value: 'session-b' }))
    on('turn.complete', () => ({ text: '' }))
    await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
    const ui = await $.ui.mount(BAR)

    await $.turn.complete(turnEnd)
    expect(await text(ui, /^Last set$/)).toBe(undefined)
    await clock.advance(60_000)
    expect(await text(ui, /^Set /)).toBe('Set 2 · You 1 : 0 Claude')
    await ui.unmount()
  })

  test('its own turn ending makes the current set the last', async ($, on) => {
    const { clock, toasts } = world(on, T0, { 'cs.day': day, 'cs.workout': { ...match(), sessionId: 'session-a' } })
    on('session.id', () => ({ value: 'session-a' }))
    on('turn.complete', () => ({ text: '' }))
    await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
    const ui = await $.ui.mount(BAR)

    await $.turn.complete(turnEnd)
    expect(await text(ui, /^Last set$/)).toBe('Last set')
    expect(toasts).toContain('Claude finished. Finish this set to win the match.')
    await clock.advance(40_000)
    expect(await text(ui, /^Set /)).toBe(undefined)
    await ui.unmount()
  })

  test('a match whose session vanished still stops after 30 sets', async () => {
    const w = { ...match(), index: 29 }
    expect(stepBeatAi(w, w.exerciseStartedAt + 40_000)).toEqual({ finished: true, sets: 30 })
  })
})
