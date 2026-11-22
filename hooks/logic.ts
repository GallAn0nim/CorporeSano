// Pure rules of corpore-sano. Nothing here touches `$`: every function takes
// the current values plus `now` and returns new values, so each rule is
// unit-tested without the engine.

import type { Bag, Day, Exercise, ExerciseFile, Group, Last, Level, Pause, Saved, Settings, Workout, WorkoutResult } from '../types'

const MINUTE = 60_000

export const DEFAULT_SETTINGS: Settings = {
  v: 1,
  enabled: true,
  level: 'easy',
  hardcore: false,
  workMinutes: 45,
  swapsPerWorkout: 3,
  animations: true,
  disabledExercises: [],
}

const LEVELS: readonly Level[] = ['easy', 'hard', 'beat-ai']

const clamp = (n: unknown, lo: number, hi: number, fallback: number): number =>
  typeof n === 'number' && Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : fallback

const bool = (b: unknown, fallback: boolean): boolean => (typeof b === 'boolean' ? b : fallback)

/** Reads whatever the store holds under cs.settings into valid settings. */
export function normalizeSettings(raw: unknown): Settings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<Record<keyof Settings, unknown>>
  const d = DEFAULT_SETTINGS
  return {
    v: 1,
    enabled: bool(r.enabled, d.enabled),
    level: LEVELS.includes(r.level as Level) ? (r.level as Level) : d.level,
    hardcore: bool(r.hardcore, d.hardcore),
    workMinutes: clamp(r.workMinutes, 15, 120, d.workMinutes),
    swapsPerWorkout: clamp(r.swapsPerWorkout, 0, 10, d.swapsPerWorkout),
    animations: bool(r.animations, d.animations),
    disabledExercises: Array.isArray(r.disabledExercises)
      ? r.disabledExercises.filter((x): x is string => typeof x === 'string')
      : [],
  }
}

/** A stored cs.day, or null when absent or from an unknown version. */
export function normalizeDay(raw: unknown): Day | null {
  const r = raw as Partial<Day> | null | undefined
  if (!r || r.v !== 1 || typeof r.date !== 'string' || typeof r.workStart !== 'number') return null
  return {
    v: 1,
    date: r.date,
    workStart: r.workStart,
    beaten: typeof r.beaten === 'number' ? r.beaten : 0,
    failed: typeof r.failed === 'number' ? r.failed : 0,
    ...(typeof r.lastScore === 'string' ? { lastScore: r.lastScore } : {}),
    ...(typeof r.dueNotified === 'number' ? { dueNotified: r.dueNotified } : {}),
  }
}

/** A stored cs.pause, or null when absent. */
export function normalizePause(raw: unknown): Pause | null {
  const r = raw as Partial<Pause> | null | undefined
  return r && r.v === 1 && typeof r.until === 'number' ? { v: 1, until: r.until } : null
}

const pad = (n: number): string => String(n).padStart(2, '0')

/** The local calendar date of `now`, YYYY-MM-DD. */
export function localDate(now: number): string {
  const d = new Date(now)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/**
 * Called on the person's prompt: starts a new day record (counter from now,
 * stats at zero) when there is none or the local date changed; otherwise the
 * same record. `isNew` says which.
 */
export function rollDay(day: Day | null, now: number): { day: Day; isNew: boolean } {
  const date = localDate(now)
  if (day && day.date === date) return { day, isNew: false }
  return { day: { v: 1, date, workStart: now, beaten: 0, failed: 0 }, isNew: true }
}

/** Turned off, or inside a timed pause. */
export function isPaused(settings: Settings, pause: Pause | null, now: number): boolean {
  return !settings.enabled || (pause !== null && pause.until > now)
}

/**
 * Milliseconds of work since the counter last reset. Zero while paused, and
 * before the first prompt of today (a record from an earlier day has not
 * been rolled yet).
 */
export function workingMs(day: Day | null, settings: Settings, pause: Pause | null, now: number): number {
  if (!day || day.date !== localDate(now) || isPaused(settings, pause, now)) return 0
  return Math.max(0, now - day.workStart)
}

/** Whole minutes of work, as the panel and bar show them. */
export const workingMinutes = (day: Day | null, settings: Settings, pause: Pause | null, now: number): number =>
  Math.floor(workingMs(day, settings, pause, now) / MINUTE)

/** The work counter is at or past `workMinutes`. */
export function isDue(day: Day | null, settings: Settings, pause: Pause | null, now: number): boolean {
  if (!day || day.date !== localDate(now) || isPaused(settings, pause, now)) return false
  return now - day.workStart >= settings.workMinutes * MINUTE
}

/** Milliseconds until the workout is due, or null when it never will be as things stand. */
export function msUntilDue(day: Day | null, settings: Settings, pause: Pause | null, now: number): number | null {
  if (!day || day.date !== localDate(now) || isPaused(settings, pause, now)) return null
  return Math.max(0, day.workStart + settings.workMinutes * MINUTE - now)
}

/** Due and not yet announced for this counter run: the toast should show. */
export function shouldAnnounceDue(day: Day | null, settings: Settings, pause: Pause | null, now: number): boolean {
  return isDue(day, settings, pause, now) && day!.dueNotified !== day!.workStart
}

/** The counter starts again from `now` (workout ended, mod turned back on). */
export function resetCounter(day: Day, now: number): Day {
  const { dueNotified: _, ...rest } = day
  return { ...rest, workStart: now }
}

// ---- Trigger ----

/** How long a turn must keep running to count as a good moment. */
export const GOOD_MOMENT_MS = 60_000
/** How long a due workout waits for a good moment before it starts anyway. */
export const DUE_WINDOW_MS = 10 * MINUTE

/** When the current counter run became due. */
export const dueSince = (day: Day, settings: Settings): number => day.workStart + settings.workMinutes * MINUTE

/**
 * While due: start now? Yes when a turn has been running for 60 s (a good
 * moment), or when 10 minutes passed without one. `turnRunningFor` is null
 * when no turn runs.
 */
export function shouldStart(since: number, now: number, turnRunningFor: number | null): boolean {
  return (turnRunningFor !== null && turnRunningFor >= GOOD_MOMENT_MS) || now - since >= DUE_WINDOW_MS
}

// ---- Exercises ----

export type Rng = () => number

export const GROUP_ORDER: readonly Group[] = ['upper', 'lower', 'wrist-balance']

export const EXERCISES_PER_WORKOUT = 3

export function exercisesOf(data: ExerciseFile, level: Level): Exercise[] {
  return level === 'easy' ? data.easy : level === 'hard' ? data.hard : data.beatAi
}

export const findExercise = (data: ExerciseFile, id: string): Exercise | undefined =>
  data.easy.find(x => x.id === id) ?? data.hard.find(x => x.id === id) ?? data.beatAi.find(x => x.id === id)

const pickOne = <T>(xs: readonly T[], rng: Rng): T | undefined => xs[Math.floor(rng() * xs.length)]

export const EMPTY_LAST: Last = { v: 1, easy: [], hard: [], beatAiIndex: 0 }
export const EMPTY_BAG: Bag = { v: 1, easy: [], hard: [] }

export function normalizeLast(raw: unknown): Last {
  const r = raw as Partial<Last> | null | undefined
  if (!r || r.v !== 1) return EMPTY_LAST
  const ids = (x: unknown): string[] => (Array.isArray(x) ? x.filter((y): y is string => typeof y === 'string') : [])
  return { v: 1, easy: ids(r.easy), hard: ids(r.hard), beatAiIndex: typeof r.beatAiIndex === 'number' ? r.beatAiIndex : 0 }
}

export function normalizeBag(raw: unknown): Bag {
  const r = raw as Partial<Bag> | null | undefined
  if (!r || r.v !== 1) return EMPTY_BAG
  const ids = (x: unknown): string[] => (Array.isArray(x) ? x.filter((y): y is string => typeof y === 'string') : [])
  return { v: 1, easy: ids(r.easy), hard: ids(r.hard) }
}

/**
 * The exercises of a new easy or hard workout, and the shuffle bag after it.
 *
 * Hardcore off: one per group, upper, lower, wrist-balance, none repeated
 * from the previous workout (that rule gives way only when a group has
 * nothing else enabled). Hardcore on: drawn from the whole enabled list
 * through a shuffle bag, so every exercise comes up once before any repeats.
 */
export function pickWorkout(
  level: 'easy' | 'hard',
  hardcore: boolean,
  exercises: readonly Exercise[],
  disabled: readonly string[],
  last: Last,
  bag: Bag,
  rng: Rng,
): { exerciseIds: string[]; bag: Bag } {
  const enabled = exercises.filter(x => !disabled.includes(x.id))
  const pool = enabled.length > 0 ? enabled : [...exercises]
  const count = Math.min(EXERCISES_PER_WORKOUT, pool.length)

  if (hardcore) {
    const ids = new Set(pool.map(x => x.id))
    let current = bag[level].filter(id => ids.has(id))
    const out: string[] = []
    while (out.length < count) {
      if (current.length === 0) current = pool.map(x => x.id).filter(id => !out.includes(id))
      const i = Math.floor(rng() * current.length)
      const [id] = current.splice(i, 1)
      if (id !== undefined && !out.includes(id)) out.push(id)
    }
    return { exerciseIds: out, bag: { ...bag, [level]: current } }
  }

  const previous = last[level]
  const out: string[] = []
  for (const group of GROUP_ORDER) {
    if (out.length >= count) break
    const inGroup = pool.filter(x => x.group === group && !out.includes(x.id))
    const fresh = inGroup.filter(x => !previous.includes(x.id))
    const choice = pickOne(fresh.length > 0 ? fresh : inGroup, rng)
    if (choice) out.push(choice.id)
  }
  // A group with nothing enabled: fill from the rest of the list.
  while (out.length < count) {
    const rest = pool.filter(x => !out.includes(x.id))
    const fresh = rest.filter(x => !previous.includes(x.id))
    const choice = pickOne(fresh.length > 0 ? fresh : rest, rng)
    if (!choice) break
    out.push(choice.id)
  }
  return { exerciseIds: out, bag }
}

/** A new workout record. */
export function startWorkout(
  level: Level,
  settings: Settings,
  exerciseIds: string[],
  now: number,
  rng: Rng,
): Workout {
  return {
    v: 1,
    id: `${now.toString(36)}-${Math.floor(rng() * 1e9).toString(36)}`,
    level,
    hardcore: settings.hardcore,
    exerciseIds,
    index: 0,
    startedAt: now,
    exerciseStartedAt: now,
    swapsLeft: settings.swapsPerWorkout,
  }
}

export function normalizeWorkout(raw: unknown): Workout | null {
  const r = raw as Partial<Workout> | null | undefined
  if (!r || r.v !== 1 || typeof r.id !== 'string' || !Array.isArray(r.exerciseIds)) return null
  if (typeof r.index !== 'number' || typeof r.exerciseStartedAt !== 'number') return null
  return r as Workout
}

/**
 * Swap: the current exercise replaced by another of its group (any exercise
 * on beat-ai) that is enabled and not already in this workout. Null when no
 * swap is left or nothing could replace it.
 */
export function swap(
  workout: Workout,
  exercises: readonly Exercise[],
  disabled: readonly string[],
  rng: Rng,
  now: number,
): Workout | null {
  if (workout.swapsLeft <= 0) return null
  const currentId = workout.exerciseIds[workout.index]
  const current = exercises.find(x => x.id === currentId)
  const candidates = exercises.filter(
    x =>
      !disabled.includes(x.id) &&
      !workout.exerciseIds.includes(x.id) &&
      (workout.level === 'beat-ai' || x.group === current?.group),
  )
  const choice = pickOne(candidates, rng)
  if (!choice) return null
  const exerciseIds = workout.exerciseIds.map((id, i) => (i === workout.index ? choice.id : id))
  return { ...workout, exerciseIds, swapsLeft: workout.swapsLeft - 1, exerciseStartedAt: now }
}

export const exerciseMs = (ex: Exercise): number => (ex.seconds ?? 40) * 1000

/** Milliseconds left on the current exercise's timer. */
export const remainingMs = (workout: Workout, ex: Exercise, now: number): number =>
  Math.max(0, workout.exerciseStartedAt + exerciseMs(ex) - now)

/** Has the current exercise's timer run out (Done unlocks). */
export const canFinishExercise = (workout: Workout, ex: Exercise, now: number): boolean =>
  remainingMs(workout, ex, now) === 0

/** Per-side exercises: past half time the bar says "Switch sides". */
export const isSecondSide = (workout: Workout, ex: Exercise, now: number): boolean =>
  !!ex.perSide && remainingMs(workout, ex, now) <= exerciseMs(ex) / 2

/** Done pressed: the next exercise, or finished after the last. */
export function advance(workout: Workout, now: number): { workout: Workout } | { finished: true } {
  const index = workout.index + 1
  if (index >= workout.exerciseIds.length) return { finished: true }
  return { workout: { ...workout, index, exerciseStartedAt: now } }
}

/**
 * A workout ended (finished, skipped or failed): stats counted and the work
 * counter back to zero. Beaten counts the exercises done.
 */
export function endWorkout(day: Day, workout: Workout, result: WorkoutResult, now: number): Day {
  if (workout.level === 'beat-ai') {
    const sets = completedSets(workout, now)
    return {
      ...resetCounter(day, now),
      beaten: day.beaten + sets,
      failed: day.failed + (result === 'failed' ? 1 : 0),
      lastScore: scoreText(sets, result),
    }
  }
  const done = result === 'finished' ? workout.exerciseIds.length : workout.index
  return {
    ...resetCounter(day, now),
    beaten: day.beaten + done,
    failed: day.failed + (result === 'failed' ? 1 : 0),
  }
}

/** Progress dots: one per exercise, filled up to the current one. */
export const progressDots = (workout: Workout): string =>
  workout.exerciseIds.map((_, i) => (i <= workout.index ? '●' : '○')).join('')

/** m:ss */
export function clockText(ms: number): string {
  const total = Math.ceil(ms / 1000)
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

// ---- Turn on / pause ----

export type PauseLength = '1h' | '2h' | 'tomorrow'

/** The moment a pause of that length ends: 1 h, 2 h, or the next local midnight. */
export function pauseUntil(length: PauseLength, now: number): number {
  if (length === '1h') return now + 60 * MINUTE
  if (length === '2h') return now + 120 * MINUTE
  const d = new Date(now)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime()
}

/** A pause whose time has come: the mod turns itself back on. */
export const isPauseOver = (pause: Pause | null, now: number): boolean => pause !== null && pause.until <= now

/**
 * Turning the mod back on (by hand or when a pause ends) resets the work
 * counter, so a pause never ends in an instant workout. A record from an
 * earlier day is left for the next prompt to roll.
 */
export function resumeDay(day: Day | null, now: number): Day | null {
  if (!day || day.date !== localDate(now)) return day
  return resetCounter(day, now)
}

/** local HH:MM */
export function timeText(ms: number): string {
  const d = new Date(ms)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

// ---- Settings edits ----

export const patchSettings = (settings: Settings, patch: Partial<Settings>): Settings =>
  normalizeSettings({ ...settings, ...patch })

/** Tick or untick one exercise in the list. */
export function toggleExercise(settings: Settings, id: string): Settings {
  const off = settings.disabledExercises.includes(id)
  return patchSettings(settings, {
    disabledExercises: off ? settings.disabledExercises.filter(x => x !== id) : [...settings.disabledExercises, id],
  })
}

export const LEVEL_DESCRIPTION: Record<Level, string> = {
  easy: 'Standing or seated at the desk, no floor work, no sweat.',
  hard: 'Mobility work that builds range of motion. Comfortable clothes needed.',
  'beat-ai': 'You will beat AI using your punches: bodyweight strength sets until Claude finishes.',
}

// ---- Beat AI: 40 s sets, 20 s rest, until the agent's turn completes ----

export const SET_WORK_MS = 40_000
export const SET_REST_MS = 20_000
/** A safety stop: a match whose session vanished without ending still ends (30 min). */
export const MAX_SETS = 30

/** A new match: rotation through the enabled list from where the last one stopped. */
export function startBeatAi(
  settings: Settings,
  exercises: readonly Exercise[],
  last: Last,
  now: number,
  rng: Rng,
  isClaudeDone: boolean,
  sessionId?: string,
): Workout | null {
  const enabled = exercises.filter(x => !settings.disabledExercises.includes(x.id))
  const rotation = (enabled.length > 0 ? enabled : [...exercises]).map(x => x.id)
  if (rotation.length === 0) return null
  const pointer = last.beatAiIndex % rotation.length
  return {
    ...startWorkout('beat-ai', settings, [rotation[pointer]!], now, rng),
    rotation,
    pointer,
    isClaudeDone,
    ...(sessionId ? { sessionId } : {}),
  }
}

export type SetPhase = { phase: 'work' | 'rest'; remainingMs: number } | { phase: 'over' }

/** Where the current set stands: 40 s work, then 20 s rest, then over. */
export function setPhase(w: Workout, now: number): SetPhase {
  const t = now - w.exerciseStartedAt
  if (t < SET_WORK_MS) return { phase: 'work', remainingMs: SET_WORK_MS - t }
  if (t < SET_WORK_MS + SET_REST_MS) return { phase: 'rest', remainingMs: SET_WORK_MS + SET_REST_MS - t }
  return { phase: 'over' }
}

/** Sets whose 40 s of work are done. */
export const completedSets = (w: Workout, now: number): number =>
  w.index + (setPhase(w, now).phase === 'work' ? 0 : 1)

/** "You 4 : 0 Claude", or "You 0 : 1 Claude" when skipped or failed. */
export const scoreText = (sets: number, result: WorkoutResult): string =>
  result === 'finished' ? `You ${sets} : 0 Claude` : 'You 0 : 1 Claude'

/** The exercise the next set takes: the next in rotation not used in this match yet, else simply the next. */
function nextInRotation(w: Workout): { id: string; pointer: number } {
  const rotation = w.rotation ?? w.exerciseIds
  const start = (w.pointer ?? 0) + 1
  for (let k = 0; k < rotation.length; k++) {
    const pointer = (start + k) % rotation.length
    const id = rotation[pointer]!
    if (!w.exerciseIds.includes(id)) return { id, pointer }
  }
  return { id: rotation[start % rotation.length]!, pointer: start % rotation.length }
}

/**
 * The match moves on with the clock: once the agent is done, the match ends
 * as soon as the current set's work is done (a match is at least one set);
 * otherwise each set's rest leads into the next set. Null: nothing changes.
 */
export function stepBeatAi(w: Workout, now: number): { workout: Workout } | { finished: true; sets: number } | null {
  const phase = setPhase(w, now)
  if (phase.phase === 'work') return null
  if (w.isClaudeDone || w.index + 1 >= MAX_SETS) return { finished: true, sets: w.index + 1 }
  if (phase.phase === 'rest') return null
  const next = nextInRotation(w)
  return {
    workout: {
      ...w,
      index: w.index + 1,
      exerciseIds: [...w.exerciseIds, next.id],
      pointer: next.pointer,
      exerciseStartedAt: w.exerciseStartedAt + SET_WORK_MS + SET_REST_MS,
    },
  }
}

/** Where the next match starts in the rotation. */
export const nextBeatAiIndex = (w: Workout): number => (w.pointer ?? 0) + 1

/** The next set's exercise, shown during rest. */
export const upNext = (w: Workout): string | null =>
  w.level === 'beat-ai' && !w.isClaudeDone ? nextInRotation(w).id : null

// ---- Hardcore ----

/** Origins of prompts the person typed; Hardcore holds these back. */
export const PERSON_ORIGINS: ReadonlySet<string> = new Set(['composer', 'bridge', 'sdk'])

/** "1 of 3 done", or the match so far on beat-ai. */
export function progressText(w: Workout, now: number): string {
  if (w.level === 'beat-ai') return `set ${w.index + 1}, You ${completedSets(w, now)} : 0 Claude`
  return `${w.index} of ${w.exerciseIds.length} done`
}

/**
 * The drop reason for a prompt during a Hardcore workout, or null to let it
 * through. Only the person's own typed prompts are held: slash commands,
 * hidden prompts and the mod's own (origin `plugin`) pass, and permission
 * answers never reach prompt.submit at all.
 */
export function blockPrompt(
  workout: Workout | null,
  origin: { kind: string },
  flags: { isCommand: boolean; isMeta: boolean },
  now: number,
): string | null {
  if (!workout || !workout.hardcore || flags.isCommand || flags.isMeta) return null
  if (!PERSON_ORIGINS.has(origin.kind)) return null
  return `Finish your workout first: ${progressText(workout, now)}.`
}

export const EMPTY_SAVED: Saved = { v: 1, bySession: {} }

export function normalizeSaved(raw: unknown): Saved {
  const r = raw as Partial<Saved> | null | undefined
  if (!r || r.v !== 1 || !r.bySession || typeof r.bySession !== 'object') return EMPTY_SAVED
  const bySession: Record<string, string> = {}
  for (const [k, v] of Object.entries(r.bySession)) if (typeof v === 'string' && v.trim()) bySession[k] = v
  return { v: 1, bySession }
}

/** Keep a held-back prompt; a second one in the same session joins the first. */
export function savePrompt(saved: Saved, sessionId: string, text: string): Saved {
  const before = saved.bySession[sessionId]
  return { v: 1, bySession: { ...saved.bySession, [sessionId]: before ? `${before}\n\n${text}` : text } }
}

/** Take this session's held-back prompt out. */
export function takeSaved(saved: Saved, sessionId: string): { text: string | null; saved: Saved } {
  const { [sessionId]: text, ...rest } = saved.bySession
  return { text: text ?? null, saved: { v: 1, bySession: rest } }
}

export const GIVE_UP_PHRASE = 'I give up'

export const isGiveUp = (text: string): boolean =>
  text.trim().replace(/\s+/g, ' ').replace(/[.!]+$/, '').toLowerCase() === GIVE_UP_PHRASE.toLowerCase()
