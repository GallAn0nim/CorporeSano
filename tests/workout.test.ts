import { describe, expect, test } from 'claude-code/testing'

import type { Day, Workout } from '../types'
import {
  DEFAULT_SETTINGS,
  EMPTY_BAG,
  EMPTY_LAST,
  advance,
  canFinishExercise,
  clockText,
  dueSince,
  endWorkout,
  isSecondSide,
  localDate,
  pickWorkout,
  progressDots,
  remainingMs,
  shouldStart,
  startWorkout,
  swap,
} from '../hooks/logic'
import { figureSvg } from '../hooks/figure'
import { FIXTURE } from './fixtures/exercises'

const MIN = 60_000
const T0 = new Date(2026, 2, 10, 9, 0, 0).getTime()
const easy = FIXTURE.easy
const groupOf = (id: string) => easy.find(x => x.id === id)?.group

/** A repeatable rng: walks through the given values. */
const seq = (...xs: number[]) => {
  let i = 0
  return () => xs[i++ % xs.length]!
}

const workout = (ids: string[], extra: Partial<Workout> = {}): Workout => ({
  ...startWorkout('easy', DEFAULT_SETTINGS, ids, T0, seq(0)),
  ...extra,
})

describe('trigger', () => {
  const since = T0 + 45 * MIN
  test('a turn still running after 60 s while due starts the workout', async () => {
    expect(shouldStart(since, since + 2 * MIN, 60_000)).toBe(true)
  })
  test('a turn that ended after 30 s does not', async () => {
    expect(shouldStart(since, since + 2 * MIN, null)).toBe(false)
    expect(shouldStart(since, since + 2 * MIN, 30_000)).toBe(false)
  })
  test('due for 10 min without a long turn: starts anyway', async () => {
    expect(shouldStart(since, since + 9 * MIN, null)).toBe(false)
    expect(shouldStart(since, since + 10 * MIN, null)).toBe(true)
  })
  test('due since is the counter start plus workMinutes', async () => {
    const day: Day = { v: 1, date: localDate(T0), workStart: T0, beaten: 0, failed: 0 }
    expect(dueSince(day, { ...DEFAULT_SETTINGS, workMinutes: 30 })).toBe(T0 + 30 * MIN)
  })
})

describe('picking, Hardcore off', () => {
  test('one per group in the order upper, lower, wrist-balance', async () => {
    for (const r of [0, 0.5, 0.99]) {
      const { exerciseIds } = pickWorkout('easy', false, easy, [], EMPTY_LAST, EMPTY_BAG, seq(r))
      expect(exerciseIds.map(groupOf)).toEqual(['upper', 'lower', 'wrist-balance'])
    }
  })
  test('nothing repeats from the previous workout', async () => {
    const last = { ...EMPTY_LAST, easy: ['u1', 'l1', 'w1'] }
    const { exerciseIds } = pickWorkout('easy', false, easy, [], last, EMPTY_BAG, seq(0))
    expect(exerciseIds).toEqual(['u2', 'l2', 'w2'])
  })
  test('unticked exercises never come up', async () => {
    const { exerciseIds } = pickWorkout('easy', false, easy, ['u1', 'u2', 'l2'], EMPTY_LAST, EMPTY_BAG, seq(0))
    expect(exerciseIds).toEqual(['u3', 'l1', 'w1'])
  })
  test('a group with nothing enabled is filled from the rest', async () => {
    const { exerciseIds } = pickWorkout('easy', false, easy, ['l1', 'l2'], EMPTY_LAST, EMPTY_BAG, seq(0))
    expect(exerciseIds.length).toBe(3)
    expect(new Set(exerciseIds).size).toBe(3)
    expect(exerciseIds.some(id => id.startsWith('l'))).toBe(false)
  })
})

describe('picking, Hardcore on', () => {
  test('the shuffle bag gives every exercise once before any repeats', async () => {
    let bag = EMPTY_BAG
    const seen: string[] = []
    for (let i = 0; i < 2; i++) {
      const r = pickWorkout('easy', true, easy.slice(0, 6), [], EMPTY_LAST, bag, seq(0.3, 0.7, 0.1))
      seen.push(...r.exerciseIds)
      bag = r.bag
    }
    expect(seen.length).toBe(6)
    expect(new Set(seen).size).toBe(6)
  })
})

describe('swap', () => {
  test('replaces the current exercise from the same group and uses a swap', async () => {
    const w = workout(['u1', 'l1', 'w1'])
    const s = swap(w, easy, [], seq(0), T0 + 10_000)!
    expect(s.exerciseIds).toEqual(['u2', 'l1', 'w1'])
    expect(s.swapsLeft).toBe(w.swapsLeft - 1)
    expect(s.exerciseStartedAt).toBe(T0 + 10_000)
  })
  test('skips disabled and already chosen exercises; none left gives null', async () => {
    const w = workout(['l1', 'u1', 'w1'])
    expect(swap(w, easy, ['l2'], seq(0), T0)).toBe(null)
    expect(swap({ ...w, swapsLeft: 0 }, easy, [], seq(0), T0)).toBe(null)
  })
})

describe('timer and Done', () => {
  const w = workout(['u1', 'l1', 'w1'])
  const u1 = easy[0]!
  const l1 = easy[3]!
  test('Done unlocks when the exercise timer reaches 0', async () => {
    expect(remainingMs(w, u1, T0 + 10_000)).toBe(20_000)
    expect(canFinishExercise(w, u1, T0 + 29_999)).toBe(false)
    expect(canFinishExercise(w, u1, T0 + 30_000)).toBe(true)
  })
  test('per-side exercises switch sides at half time', async () => {
    expect(isSecondSide(w, l1, T0 + 19_000)).toBe(false)
    expect(isSecondSide(w, l1, T0 + 20_000)).toBe(true)
    expect(isSecondSide(w, u1, T0 + 20_000)).toBe(false)
  })
  test('advance moves on, then finishes after the last', async () => {
    const a = advance(w, T0 + MIN)
    expect('workout' in a && a.workout.index).toBe(1)
    expect('workout' in a && a.workout.exerciseStartedAt).toBe(T0 + MIN)
    expect(advance({ ...w, index: 2 }, T0)).toEqual({ finished: true })
  })
  test('dots and the clock', async () => {
    expect(progressDots({ ...w, index: 1 })).toBe('●●○')
    expect(clockText(30_000)).toBe('0:30')
    expect(clockText(61_000)).toBe('1:01')
    expect(clockText(400)).toBe('0:01')
  })
})

describe('ending', () => {
  const day: Day = { v: 1, date: localDate(T0), workStart: T0, beaten: 2, failed: 0, dueNotified: T0 }
  const w = workout(['u1', 'l1', 'w1'], { index: 1 })
  test('finished: all exercises beaten, counter reset', async () => {
    const d = endWorkout(day, w, 'finished', T0 + 50 * MIN)
    expect(d).toEqual({ v: 1, date: day.date, workStart: T0 + 50 * MIN, beaten: 5, failed: 0 })
  })
  test('skipped: the ones done count, counter reset', async () => {
    expect(endWorkout(day, w, 'skipped', T0 + 50 * MIN).beaten).toBe(3)
  })
  test('failed: one failed workout', async () => {
    expect(endWorkout(day, w, 'failed', T0 + 50 * MIN).failed).toBe(1)
  })
})

describe('figure', () => {
  test('two keyframes animate A → B → A over tempo × keyframes', async () => {
    const svg = figureSvg(easy[0]!, FIXTURE.bases, { animate: true })
    expect(svg).toContain('attributeName="cy" values="15;20;15"')
    expect(svg).toContain('dur="2000ms"')
    expect(svg.length).toBeLessThan(131_072)
  })
  test('animations off: the first pose, no <animate>', async () => {
    expect(figureSvg(easy[0]!, FIXTURE.bases, { animate: false })).not.toContain('<animate')
  })
})
