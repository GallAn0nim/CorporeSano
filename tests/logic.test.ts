import { describe, expect, test } from 'claude-code/testing'

import type { Day, Settings } from '../types'
import {
  DEFAULT_SETTINGS,
  isDue,
  isPaused,
  localDate,
  msUntilDue,
  normalizeSettings,
  resetCounter,
  rollDay,
  shouldAnnounceDue,
  workingMinutes,
} from '../hooks/logic'

const MIN = 60_000
// A fixed local moment: 2026-03-10 09:00 local time.
const T0 = new Date(2026, 2, 10, 9, 0, 0).getTime()
const NEXT_DAY = new Date(2026, 2, 11, 8, 0, 0).getTime()
const S: Settings = DEFAULT_SETTINGS

const dayAt = (workStart: number, extra: Partial<Day> = {}): Day => ({
  v: 1,
  date: localDate(workStart),
  workStart,
  beaten: 0,
  failed: 0,
  ...extra,
})

describe('counter', () => {
  test('first prompt of the day starts the counter at now', async () => {
    const { day, isNew } = rollDay(null, T0)
    expect(isNew).toBe(true)
    expect(day).toEqual({ v: 1, date: '2026-03-10', workStart: T0, beaten: 0, failed: 0 })
    expect(workingMinutes(day, S, null, T0)).toBe(0)
  })

  test('later prompts the same day keep the counter running', async () => {
    const first = rollDay(null, T0).day
    const { day, isNew } = rollDay(first, T0 + 30 * MIN)
    expect(isNew).toBe(false)
    expect(day).toBe(first)
    expect(workingMinutes(day, S, null, T0 + 30 * MIN)).toBe(30)
  })

  test('the first prompt of a new day resets counter and stats', async () => {
    const old = dayAt(T0, { beaten: 4, failed: 1, lastScore: 'You 3 : 0 Claude' })
    const { day, isNew } = rollDay(old, NEXT_DAY)
    expect(isNew).toBe(true)
    expect(day).toEqual({ v: 1, date: '2026-03-11', workStart: NEXT_DAY, beaten: 0, failed: 0 })
  })

  test('a record from an earlier day reads as zero until the next prompt', async () => {
    const old = dayAt(T0)
    expect(workingMinutes(old, S, null, NEXT_DAY)).toBe(0)
    expect(isDue(old, S, null, NEXT_DAY)).toBe(false)
    expect(msUntilDue(old, S, null, NEXT_DAY)).toBe(null)
  })

  test('there is no idle reset: a long break still counts', async () => {
    const day = dayAt(T0)
    expect(workingMinutes(day, S, null, T0 + 3 * 60 * MIN)).toBe(180)
  })

  test('resetCounter starts again from now and forgets the due toast', async () => {
    const day = dayAt(T0, { dueNotified: T0, beaten: 2 })
    expect(resetCounter(day, T0 + 50 * MIN)).toEqual({ ...dayAt(T0, { beaten: 2 }), workStart: T0 + 50 * MIN })
  })
})

describe('due', () => {
  test('due at exactly workMinutes, not a minute before', async () => {
    const day = dayAt(T0)
    expect(isDue(day, S, null, T0 + 44 * MIN)).toBe(false)
    expect(msUntilDue(day, S, null, T0 + 44 * MIN)).toBe(MIN)
    expect(isDue(day, S, null, T0 + 45 * MIN)).toBe(true)
    expect(msUntilDue(day, S, null, T0 + 50 * MIN)).toBe(0)
  })

  test('workMinutes comes from settings', async () => {
    const s = { ...S, workMinutes: 15 }
    expect(isDue(dayAt(T0), s, null, T0 + 15 * MIN)).toBe(true)
  })

  test('turned off: nothing is due and the counter does not run', async () => {
    const off = { ...S, enabled: false }
    expect(isPaused(off, null, T0)).toBe(true)
    expect(isDue(dayAt(T0), off, null, T0 + 90 * MIN)).toBe(false)
    expect(workingMinutes(dayAt(T0), off, null, T0 + 90 * MIN)).toBe(0)
  })

  test('paused for 1 h: not due for that hour, due again after', async () => {
    const pause = { v: 1 as const, until: T0 + 60 * MIN }
    expect(isDue(dayAt(T0), S, pause, T0 + 59 * MIN)).toBe(false)
    expect(isPaused(S, pause, T0 + 60 * MIN)).toBe(false)
  })

  test('the due toast shows once per counter run', async () => {
    const day = dayAt(T0)
    const now = T0 + 46 * MIN
    expect(shouldAnnounceDue(day, S, null, now)).toBe(true)
    expect(shouldAnnounceDue({ ...day, dueNotified: T0 }, S, null, now)).toBe(false)
    const reset = resetCounter({ ...day, dueNotified: T0 }, now)
    expect(shouldAnnounceDue(reset, S, null, now + 45 * MIN)).toBe(true)
  })
})

describe('settings', () => {
  test('missing or broken settings fall back to defaults', async () => {
    expect(normalizeSettings(undefined)).toEqual(DEFAULT_SETTINGS)
    expect(normalizeSettings('nonsense')).toEqual(DEFAULT_SETTINGS)
  })

  test('numbers are clamped to their ranges', async () => {
    const s = normalizeSettings({ workMinutes: 5, swapsPerWorkout: 99, level: 'insane' })
    expect(s.workMinutes).toBe(15)
    expect(s.swapsPerWorkout).toBe(10)
    expect(s.level).toBe('easy')
    expect(normalizeSettings({ workMinutes: 500 }).workMinutes).toBe(120)
  })
})
