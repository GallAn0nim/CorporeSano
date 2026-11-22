import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren, Timer } from 'claude-code'

import type { Day, ExerciseFile, Level, Pause, Saved, Settings, Workout, WorkoutResult } from '../types'
import type { PauseLength } from './logic'
import { figureSvg } from './figure'
import {
  DEFAULT_SETTINGS,
  GIVE_UP_PHRASE,
  GOOD_MOMENT_MS,
  PERSON_ORIGINS,
  blockPrompt,
  isGiveUp,
  normalizeSaved,
  savePrompt,
  takeSaved,
  LEVEL_DESCRIPTION,
  advance,
  canFinishExercise,
  completedSets,
  clockText,
  dueSince,
  endWorkout,
  exercisesOf,
  findExercise,
  isDue,
  isPauseOver,
  isPaused,
  localDate,
  isSecondSide,
  normalizeBag,
  normalizeDay,
  normalizeLast,
  normalizePause,
  normalizeSettings,
  normalizeWorkout,
  patchSettings,
  pauseUntil,
  pickWorkout,
  scoreText,
  setPhase,
  startBeatAi,
  stepBeatAi,
  upNext,
  progressDots,
  remainingMs,
  resetCounter,
  resumeDay,
  rollDay,
  shouldAnnounceDue,
  shouldStart,
  startWorkout,
  swap,
  timeText,
  toggleExercise,
  msUntilDue,
  nextBeatAiIndex,
  workingMinutes,
} from './logic'

// ---- Store keys (shared by every session) ----
const K = {
  settings: 'cs.settings',
  pause: 'cs.pause',
  day: 'cs.day',
  workout: 'cs.workout',
  last: 'cs.last',
  bag: 'cs.bag',
  saved: 'cs.saved',
} as const

// ---- Session mirrors of the store, read while drawing ----
const settingsAtom = atom({ plugin: 'corpore-sano', key: 'settings' } as const, DEFAULT_SETTINGS)
const dayAtom = atom({ plugin: 'corpore-sano', key: 'day' } as const, null)
const pauseAtom = atom({ plugin: 'corpore-sano', key: 'pause' } as const, null)
const workoutAtom = atom({ plugin: 'corpore-sano', key: 'workout' } as const, null)
const turnAtom = atom({ plugin: 'corpore-sano', key: 'turnStartedAt' } as const, null)
const nowAtom = atom({ plugin: 'corpore-sano', key: 'now' } as const, 0)
const askPauseAtom = atom({ plugin: 'corpore-sano', key: 'isAskingPause' } as const, false)
const givingUpAtom = atom({ plugin: 'corpore-sano', key: 'isGivingUp' } as const, false)
const savedAtom = atom({ plugin: 'corpore-sano', key: 'saved' } as const, null)

const PANE = 'corpore-sano'

const POLL_MS = 30_000 // between workouts
const WORKOUT_POLL_MS = 5_000 // while the bar is drawn
const MINUTE = 60_000

const LEVEL_LABEL: Record<Level, string> = { easy: 'Easy', hard: 'Hard', 'beat-ai': 'Beat AI' }
const HINT = 'Look into the distance for a few seconds.'
const DISCLAIMER =
  "I'm not a doctor, physiotherapist or personal trainer, so this is not medical advice. Stretches should be felt, never painful. Stop if anything hurts, tingles or goes numb, and ask a physiotherapist if you have an injury."
const WORK_MINUTES = [15, 20, 25, 30, 40, 45, 50, 60, 75, 90, 105, 120]


type Snapshot = {
  settings: Settings
  day: Day | null
  pause: Pause | null
  workout: Workout | null
  saved: Saved
  now: number
}

const rng = (): number => Math.random()

// Module state, rebuilt at every (re)load: the exercise file and this
// session's timers.
let data: ExerciseFile | null = null
let goodMoment: Timer | null = null
let ticker: Timer | null = null
let lastWorkoutPoll = 0

async function loadData($: EngineInterface): Promise<ExerciseFile | null> {
  if (data) return data
  try {
    data = JSON.parse(await $.fs.read(`${$.plugin.root}/data/exercises.json`)) as ExerciseFile
  } catch (err) {
    $.ui.toast(`Corpore Sano: could not read data/exercises.json (${String(err)}).`)
    data = null
  }
  return data
}

async function readStore($: EngineInterface): Promise<Snapshot> {
  const [settings, day, pause, workout, saved, now] = await Promise.all([
    $.store.get(K.settings),
    $.store.get(K.day),
    $.store.get(K.pause),
    $.store.get(K.workout),
    $.store.get(K.saved),
    $.clock.now(),
  ])
  return {
    settings: normalizeSettings(settings),
    day: normalizeDay(day),
    pause: normalizePause(pause),
    workout: normalizeWorkout(workout),
    saved: normalizeSaved(saved),
    now,
  }
}

async function mirror($: EngineInterface, snap: Snapshot): Promise<void> {
  await Promise.all([
    update($, settingsAtom, () => snap.settings),
    update($, dayAtom, () => snap.day),
    update($, pauseAtom, () => snap.pause),
    update($, workoutAtom, () => snap.workout),
    update($, savedAtom, () => snap.saved),
    update($, nowAtom, () => snap.now),
  ])
}

/** While a workout is shown: a 1 s tick for the timer, a 5 s store poll. */
function setTicker($: EngineInterface, isActive: boolean): void {
  if (isActive && !ticker) {
    ticker = $.clock.every(1000, () => void tick($))
  } else if (!isActive && ticker) {
    ticker.cancel()
    ticker = null
  }
}

async function tick($: EngineInterface): Promise<void> {
  const now = await $.clock.now()
  const w = await read($, workoutAtom)
  if (w?.level === 'beat-ai' && stepBeatAi(w, now)) {
    await stepMatch($)
  } else if (now - lastWorkoutPoll >= WORKOUT_POLL_MS) {
    await sync($)
  } else {
    await update($, nowAtom, () => now)
  }
}

/**
 * Pull the shared values into this session's atoms, then act on them:
 * announce a due workout once, and start it when the 10-minute window
 * for a good moment has passed.
 */
async function sync($: EngineInterface): Promise<Snapshot> {
  let snap = await readStore($)
  if (isPauseOver(snap.pause, snap.now)) {
    // Re-read before writing: another session may have resumed already.
    if (isPauseOver(normalizePause(await $.store.get(K.pause)), snap.now)) {
      await turnOnNow($, snap.now)
      $.ui.toast('Corpore Sano is back on.')
    }
    snap = await readStore($)
  }
  lastWorkoutPoll = snap.now
  await mirror($, snap)
  setTicker($, snap.workout !== null)
  if (snap.workout?.level === 'beat-ai' && stepBeatAi(snap.workout, snap.now)) return stepMatch($)

  if (snap.workout || !isDue(snap.day, snap.settings, snap.pause, snap.now)) return snap

  if (shouldAnnounceDue(snap.day, snap.settings, snap.pause, snap.now)) {
    const fresh = normalizeDay(await $.store.get(K.day))
    if (fresh && shouldAnnounceDue(fresh, snap.settings, snap.pause, snap.now)) {
      const day: Day = { ...fresh, dueNotified: fresh.workStart }
      await $.store.set(K.day, day)
      await update($, dayAtom, () => day)
      $.ui.toast('Corpore Sano: a workout is due. It starts during the next longer task.', { timeoutMs: 8000 })
    }
  }
  const turnStartedAt = await read($, turnAtom)
  const runningFor = turnStartedAt === null ? null : snap.now - turnStartedAt
  if (snap.day && shouldStart(dueSince(snap.day, snap.settings), snap.now, runningFor)) {
    return (await tryStart($)) ?? snap
  }
  return snap
}

/** Start the due workout unless another session already did. */
async function tryStart($: EngineInterface, force = false): Promise<Snapshot | null> {
  const ex = await loadData($)
  if (!ex) return null
  const snap = await readStore($)
  if (snap.workout) return snap
  if (!force && !isDue(snap.day, snap.settings, snap.pause, snap.now)) return null

  const last = normalizeLast(await $.store.get(K.last))
  if (snap.settings.level === 'beat-ai') {
    // The match plays against this session's turn; no turn running here: one set.
    const isClaudeDone = (await read($, turnAtom)) === null
    const sessionId = await $.session.id()
    const match = startBeatAi(snap.settings, ex.beatAi, last, snap.now, rng, isClaudeDone, sessionId)
    if (!match) return null
    if (normalizeWorkout(await $.store.get(K.workout))) return readStore($)
    await $.store.set(K.workout, match)
    return sync($)
  }
  const level: 'easy' | 'hard' = snap.settings.level
  const bag = normalizeBag(await $.store.get(K.bag))
  const picked = pickWorkout(
    level,
    snap.settings.hardcore,
    exercisesOf(ex, level),
    snap.settings.disabledExercises,
    last,
    bag,
    rng,
  )
  if (picked.exerciseIds.length === 0) return null
  const workout = startWorkout(level, snap.settings, picked.exerciseIds, snap.now, rng)

  // Re-read right before writing: last write wins across sessions.
  if (normalizeWorkout(await $.store.get(K.workout))) return readStore($)
  await $.store.set(K.workout, workout)
  await $.store.set(K.last, { ...last, [level]: picked.exerciseIds })
  if (snap.settings.hardcore) await $.store.set(K.bag, picked.bag)
  return sync($)
}

/** Change the active workout, if it is still the one this press saw. */
async function withWorkout(
  $: EngineInterface,
  id: string,
  fn: (w: Workout, ex: ExerciseFile, now: number, settings: Settings) => Promise<void>,
): Promise<void> {
  const ex = await loadData($)
  const snap = await readStore($)
  if (!ex || !snap.workout || snap.workout.id !== id) {
    await sync($)
    return
  }
  await fn(snap.workout, ex, snap.now, snap.settings)
  await sync($)
}

async function finish($: EngineInterface, w: Workout, result: WorkoutResult, now: number): Promise<void> {
  const rolled = rollDay(normalizeDay(await $.store.get(K.day)), now).day
  await $.store.set(K.day, endWorkout(rolled, w, result, now))
  await $.store.delete(K.workout)
  if (w.level === 'beat-ai') {
    const last = normalizeLast(await $.store.get(K.last))
    await $.store.set(K.last, { ...last, beatAiIndex: nextBeatAiIndex(w) })
    const score = scoreText(completedSets(w, now), result)
    $.ui.toast(result === 'finished' ? `Corpore Sano: ${score}. You beat AI.` : `Corpore Sano: ${score}.`)
    return
  }
  $.ui.toast(
    result === 'finished'
      ? 'Corpore Sano: workout done. Nice.'
      : result === 'failed'
        ? 'Corpore Sano: workout failed.'
        : 'Corpore Sano: workout skipped.',
  )
}

/** Beat AI moves with the clock: next set, or the end of the match. */
async function stepMatch($: EngineInterface): Promise<Snapshot> {
  const snap = await readStore($)
  const w = snap.workout
  const step = w?.level === 'beat-ai' ? stepBeatAi(w, snap.now) : null
  if (w && step) {
    if ('finished' in step) await finish($, w, 'finished', snap.now)
    else await $.store.set(K.workout, step.workout)
  }
  const after = await readStore($)
  lastWorkoutPoll = after.now
  await mirror($, after)
  setTicker($, after.workout !== null)
  return after
}

/**
 * This session's turn completed (or the session ended): a Beat AI match it
 * started ends after the current set. Turns in other sessions change nothing.
 * True when it marked the match.
 */
async function markClaudeDone($: EngineInterface, sessionId: string): Promise<boolean> {
  const w = normalizeWorkout(await $.store.get(K.workout))
  if (w?.level !== 'beat-ai' || w.isClaudeDone) return false
  if (w.sessionId !== undefined && w.sessionId !== sessionId) return false
  await $.store.set(K.workout, { ...w, isClaudeDone: true })
  return true
}

const onDone = ($: EngineInterface, id: string) =>
  withWorkout($, id, async (w, ex, now) => {
    const current = findExercise(ex, w.exerciseIds[w.index] ?? '')
    if (current && !canFinishExercise(w, current, now)) return
    const next = advance(w, now)
    if ('finished' in next) await finish($, w, 'finished', now)
    else await $.store.set(K.workout, next.workout)
  })

const onSkip = ($: EngineInterface, id: string) =>
  withWorkout($, id, async (w, _ex, now) => {
    if (w.hardcore) return
    await finish($, w, 'skipped', now)
  })

const onSwap = ($: EngineInterface, id: string) =>
  withWorkout($, id, async (w, ex, now, settings) => {
    const swapped = swap(w, exercisesOf(ex, w.level), settings.disabledExercises, rng, now)
    if (swapped) await $.store.set(K.workout, swapped)
    else $.ui.toast('Corpore Sano: nothing left to swap in.')
  })

// ---- Panel actions ----

/** Turn on: no pause, enabled, and the work counter starts again from now. */
async function turnOnNow($: EngineInterface, now: number): Promise<void> {
  await $.store.delete(K.pause)
  const settings = normalizeSettings(await $.store.get(K.settings))
  if (!settings.enabled) await $.store.set(K.settings, patchSettings(settings, { enabled: true }))
  const day = resumeDay(normalizeDay(await $.store.get(K.day)), now)
  if (day) await $.store.set(K.day, day)
}

async function onTurnOn($: EngineInterface): Promise<void> {
  await turnOnNow($, await $.clock.now())
  await sync($)
}

/** Turn off for a while. A workout in progress ends as skipped. */
async function onTurnOff($: EngineInterface, length: PauseLength): Promise<void> {
  const now = await $.clock.now()
  const w = normalizeWorkout(await $.store.get(K.workout))
  if (w?.hardcore) {
    // Hardcore: only after "I give up", and the workout counts as failed.
    if (!(await read($, givingUpAtom))) return
    await finish($, w, 'failed', now)
  } else if (w) {
    await finish($, w, 'skipped', now)
  }
  await $.store.set(K.pause, { v: 1, until: pauseUntil(length, now) })
  await update($, askPauseAtom, () => false)
  await update($, givingUpAtom, () => false)
  await sync($)
}

async function onGiveUpInput($: EngineInterface, text: string): Promise<void> {
  if (isGiveUp(text)) await update($, givingUpAtom, () => true)
  else $.ui.toast(`Type exactly: ${GIVE_UP_PHRASE}`)
}

async function onCancelTurnOff($: EngineInterface): Promise<void> {
  await update($, askPauseAtom, () => false)
  await update($, givingUpAtom, () => false)
}

// ---- Held-back prompts ----

/** Hardcore held a prompt back: keep its text for "Send saved prompt". */
async function holdPrompt($: EngineInterface, text: string): Promise<void> {
  const sessionId = await $.session.id()
  // Re-read right before writing (last write wins across sessions).
  const saved = savePrompt(normalizeSaved(await $.store.get(K.saved)), sessionId, text)
  await $.store.set(K.saved, saved)
  await update($, savedAtom, () => saved)
}

async function onSendSaved($: EngineInterface): Promise<void> {
  const sessionId = await $.session.id()
  const { text, saved } = takeSaved(normalizeSaved(await $.store.get(K.saved)), sessionId)
  await $.store.set(K.saved, saved)
  await update($, savedAtom, () => saved)
  if (text) await $.prompt.submit({ text, asUser: true })
}

async function onDiscardSaved($: EngineInterface): Promise<void> {
  const sessionId = await $.session.id()
  const { saved } = takeSaved(normalizeSaved(await $.store.get(K.saved)), sessionId)
  await $.store.set(K.saved, saved)
  await update($, savedAtom, () => saved)
}

async function onSettings($: EngineInterface, fn: (s: Settings) => Settings): Promise<void> {
  // Re-read right before writing (last write wins across sessions).
  await $.store.set(K.settings, fn(normalizeSettings(await $.store.get(K.settings))))
  await sync($)
}

/**
 * Developer helpers, only with CORPORE_SANO_DEV=1 in the environment:
 * `/corpore-sano due | start | show <exercise-id> | yesterday | reset`.
 */
async function devCommand($: EngineInterface, args: string): Promise<string | null> {
  if ((await $.env.get('CORPORE_SANO_DEV')) !== '1') return null
  const now = await $.clock.now()
  const settings = normalizeSettings(await $.store.get(K.settings))
  const day = normalizeDay(await $.store.get(K.day))
  switch (args.trim().split(/\s+/)[0]) {
    case 'due': {
      const base = day ?? rollDay(null, now).day
      await $.store.set(K.day, resetCounter(base, now - settings.workMinutes * MINUTE))
      return 'Work counter moved back: the workout is due now and waits for a good moment.'
    }
    case 'start': {
      if (!day) await $.store.set(K.day, rollDay(null, now).day)
      const started = await tryStart($, true)
      return started?.workout ? 'Workout started.' : 'Could not start a workout.'
    }
    case 'show': {
      // Not a real workout: one exercise, to look at its figure in the bar.
      const id = args.trim().split(/\s+/)[1] ?? ''
      const ex = await loadData($)
      const level: Level | null = !ex
        ? null
        : ex.easy.some(x => x.id === id)
          ? 'easy'
          : ex.hard.some(x => x.id === id)
            ? 'hard'
            : ex.beatAi.some(x => x.id === id)
              ? 'beat-ai'
              : null
      if (!level) return `No exercise with the id "${id}".`
      if (!day) await $.store.set(K.day, rollDay(null, now).day)
      const w = startWorkout(level, { ...settings, hardcore: false }, [id], now, rng)
      await $.store.set(K.workout, level === 'beat-ai' ? { ...w, rotation: [id], pointer: 0, isClaudeDone: true } : w)
      return `Showing ${id}. Skip ends it.`
    }
    case 'yesterday': {
      if (!day) return 'No day record yet: send a prompt first.'
      await $.store.set(K.day, { ...day, date: '2000-01-01' })
      return 'Day record set to an earlier day: the next prompt starts a new day.'
    }
    case 'reset': {
      await $.store.delete(K.day)
      await $.store.delete(K.workout)
      return 'Day record and workout removed: the next prompt starts the counter.'
    }
    default:
      return null
  }
}

export const register: Register = on => {
  // ---- Events ----

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'corpore-sano',
      description: 'Open the Corpore Sano panel',
    })
    await loadData($)
    await sync($)
    $.clock.every(POLL_MS, () => void sync($))
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    // Hardcore: while a workout is active, the person's prompts wait.
    const active = normalizeWorkout(await $.store.get(K.workout))
    const reason = blockPrompt(active, e.origin, { isCommand: !!e.command, isMeta: !!e.isMeta }, await $.clock.now())
    if (reason) {
      await holdPrompt($, e.text)
      return { drop: reason }
    }
    if (!e.command && !e.isMeta && PERSON_ORIGINS.has(e.origin.kind)) {
      const snap = await readStore($)
      if (!isPaused(snap.settings, snap.pause, snap.now)) {
        // Re-read the day right before writing (last write wins across sessions).
        const { day, isNew } = rollDay(normalizeDay(await $.store.get(K.day)), snap.now)
        if (isNew) await $.store.set(K.day, day)
      }
      await sync($)
    }
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    const now = await $.clock.now()
    await update($, turnAtom, () => now)
    goodMoment?.cancel()
    // A good moment: this turn is still running 60 s from now.
    goodMoment = $.clock.after(GOOD_MOMENT_MS, () => {
      goodMoment = null
      void (async () => {
        if ((await read($, turnAtom)) === now) await sync($)
      })()
    })
    await sync($)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    goodMoment?.cancel()
    goodMoment = null
    await update($, turnAtom, () => null)
    const isMatchOver = await markClaudeDone($, await $.session.id())
    const snap = await sync($)
    if (isMatchOver) {
      $.ui.toast('Claude finished. Finish this set to win the match.')
    } else if (snap.workout && snap.workout.level !== 'beat-ai') {
      $.ui.toast(snap.workout.hardcore ? 'Claude finished. Finish your workout first.' : 'Claude finished.')
    }
    return next(e)
  })

  // The match's session closing (or /clear) ends its match after the current set.
  on('session.end', async ($, e, next) => {
    await markClaudeDone($, e.sessionId)
    return next(e)
  })

  on('command.run', { command: 'corpore-sano' }, async ($, e) => {
    const dev = e.args.trim() === '' ? null : await devCommand($, e.args)
    if (dev !== null) return { text: `${dev}\n${statusLine(await sync($))}` }
    const opened = await $.ui.open({ id: PANE, title: 'Corpore Sano' })
    const snap = await sync($)
    return { text: opened.isPlaced ? 'Corpore Sano panel opened.' : statusLine(snap) }
  })

  // ---- The side panel ----

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const [settings, day, pause, workout, now, isAskingPause, isGivingUp] = await Promise.all([
      read($, settingsAtom),
      read($, dayAtom),
      read($, pauseAtom),
      read($, workoutAtom),
      read($, nowAtom),
      read($, askPauseAtom),
      read($, givingUpAtom),
    ])
    const { Box, Text, Button, Select, Input } = $.ui.resolve(e)
    const snap: Snapshot = { settings, day, pause, workout, now, saved: { v: 1, bySession: {} } }
    const isOn = !isPaused(settings, pause, now)
    const working = workingMinutes(day, settings, pause, now)
    const isToday = day !== null && day.date === localDate(now)
    const beaten = isToday ? day.beaten : 0
    const failed = isToday ? day.failed : 0

    if (e.props.placement === 'widget') {
      return (
        <Box flexDirection="column">
          <Text weight="semibold">Corpore Sano</Text>
          <Text size="caption" dimColor>
            {statusLine(snap).replace('Corpore Sano · ', '')}
          </Text>
        </Box>
      )
    }

    const list = data ? exercisesOf(data, settings.level) : []
    const onCount = list.filter(x => !settings.disabledExercises.includes(x.id)).length
    const left = msUntilDue(day, settings, pause, now)
    const next = !isOn
      ? pause && pause.until > now
        ? `Off until ${timeText(pause.until)}`
        : 'Off'
      : workout
        ? 'Workout in progress'
        : left === null
          ? 'Starts at your first prompt'
          : left === 0
            ? 'Due, waiting for a longer task'
            : `Next workout in ${Math.ceil(left / MINUTE)} min`

    const card = (key: string, children: RenderChildren[], grow = false) => (
      <Box
        key={key}
        flexDirection="column"
        gap={1}
        borderStyle="round"
        borderDimColor
        paddingX={2}
        paddingY={1}
        flexGrow={grow ? 1 : 0}
        flexShrink={1}
        width={grow ? '50%' : undefined}
      >
        {children}
      </Box>
    )
    const label = (t: string) => (
      <Text size="caption" weight="semibold" dimColor>
        {t.toUpperCase()}
      </Text>
    )
    /** One setting: its name (and a hint) on the left, its control on the right. */
    const row = (key: string, name: string, control: RenderChildren, hint?: string) => (
      <Box key={key} flexDirection="row" gap={2} alignItems="center" justifyContent="space-between">
        <Box flexDirection="column" flexShrink={1}>
          <Text weight="medium">{name}</Text>
          {hint ? (
            <Text size="caption" dimColor>
              {hint}
            </Text>
          ) : null}
        </Box>
        {control}
      </Box>
    )
    const toggle = (key: string, isChecked: boolean, onPress: () => Promise<void>) => (
      <Button key={key} label={isChecked ? 'On' : 'Off'} variant={isChecked ? 'primary' : 'secondary'} onPress={onPress} />
    )

    const turnOn = isOn ? (
      <Button key="off" label="Turn off" variant="secondary" onPress={() => update($, askPauseAtom, () => true)} />
    ) : (
      <Button key="on" label="Turn on" variant="primary" onPress={() => onTurnOn($)} />
    )

    const pauseChoices =
      isOn && isAskingPause && workout?.hardcore && !isGivingUp ? (
        <Box key="give-up-box" flexDirection="column" gap={1}>
          <Text size="footnote">
            Hardcore is on and a workout is in progress. Turning off now counts as a failed workout.
          </Text>
          <Input
            key="give-up"
            label={`Type ${GIVE_UP_PHRASE} to continue`}
            placeholder={GIVE_UP_PHRASE}
            submitLabel="Continue"
            onSubmit={v => onGiveUpInput($, v)}
          />
          <Button key="off-cancel" label="Keep going" plain onPress={() => onCancelTurnOff($)} />
        </Box>
      ) : isOn && isAskingPause ? (
        <Box key="pause-box" flexDirection="column" gap={1}>
          <Text size="footnote">Turn off for how long? It turns itself back on after that.</Text>
          <Box flexDirection="row" gap={1} flexWrap="wrap">
            <Button key="off-1h" label="1 h" variant="secondary" onPress={() => onTurnOff($, '1h')} />
            <Button key="off-2h" label="2 h" variant="secondary" onPress={() => onTurnOff($, '2h')} />
            <Button key="off-tomorrow" label="Until tomorrow" variant="secondary" onPress={() => onTurnOff($, 'tomorrow')} />
            <Button key="off-cancel" label="Keep it on" plain onPress={() => onCancelTurnOff($)} />
          </Box>
          {workout ? (
            <Text size="caption" dimColor>
              {workout.hardcore ? 'The workout in progress counts as failed.' : 'The workout in progress ends as skipped.'}
            </Text>
          ) : null}
        </Box>
      ) : null

    // Easy and hard: grouped as the workout picks them. Beat AI: rotation order.
    const groups: { title: string | null; items: typeof list }[] =
      settings.level === 'beat-ai'
        ? [{ title: 'In rotation order', items: list }]
        : [
            { title: 'Upper body', items: list.filter(x => x.group === 'upper') },
            { title: 'Lower body', items: list.filter(x => x.group === 'lower') },
            { title: 'Wrists and balance', items: list.filter(x => x.group === 'wrist-balance') },
          ].filter(g => g.items.length > 0)

    return (
      <Box flexDirection="column" gap={2} paddingX={1} paddingY={1}>
        <Box flexDirection="column" gap={1}>
          <Text size="heading" weight="semibold">
            Mens sana in corpore sano
          </Text>
          <Text size="footnote">
            After {settings.workMinutes} minutes of work, Corpore Sano waits for Claude to start a longer task and shows a
            short workout above the prompt. You move while the agent works.
          </Text>
          <Text size="caption" dimColor italic>
            {DISCLAIMER}
          </Text>
        </Box>

        <Box flexDirection="row" gap={2} alignItems="stretch">
          {card(
            'working',
            [
              label('Working'),
              <Text key="w" size="title" tabular weight="semibold">
                {working} min
              </Text>,
              <Text key="n" size="caption" dimColor>
                {next}
              </Text>,
            ],
            true,
          )}
          {card(
            'today',
            [
              label('Today'),
              <Text key="b" size="title" tabular weight="semibold">
                {beaten}
              </Text>,
              <Text key="bl" size="caption" dimColor>
                {`exercises beaten · ${failed} ${failed === 1 ? 'workout' : 'workouts'} failed`}
              </Text>,
              settings.level === 'beat-ai' && isToday && day.lastScore ? (
                <Text key="s" size="caption">
                  Last match: {day.lastScore}
                </Text>
              ) : null,
            ],
            true,
          )}
        </Box>

        {card('settings', [
          label('Settings'),
          row('row-on', isOn ? 'On' : 'Off', turnOn, isOn ? 'Turning off asks for how long' : next),
          pauseChoices,
          row(
            'row-level',
            'Level',
            <Select
              key="level"
              value={settings.level}
              options={[
                { value: 'easy', label: 'Easy' },
                { value: 'hard', label: 'Hard' },
                { value: 'beat-ai', label: 'Beat AI' },
              ]}
              onSelect={v => onSettings($, s => patchSettings(s, { level: v as Level }))}
            />,
            LEVEL_DESCRIPTION[settings.level],
          ),
          row(
            'row-minutes',
            'Work before a workout',
            <Select
              key="work-minutes"
              value={String(settings.workMinutes)}
              options={WORK_MINUTES.map(m => ({ value: String(m), label: `${m} min` }))}
              onSelect={v => onSettings($, s => patchSettings(s, { workMinutes: Number(v) }))}
            />,
          ),
          row(
            'row-swaps',
            'Swaps per workout',
            <Select
              key="swaps"
              value={String(settings.swapsPerWorkout)}
              options={Array.from({ length: 11 }, (_, n) => ({ value: String(n), label: String(n) }))}
              onSelect={v => onSettings($, s => patchSettings(s, { swapsPerWorkout: Number(v) }))}
            />,
          ),
          row(
            'row-hardcore',
            'Hardcore',
            toggle('hardcore', settings.hardcore, () => onSettings($, s => patchSettings(s, { hardcore: !s.hardcore }))),
            'No Skip; your prompts wait until the workout is done',
          ),
          row(
            'row-animations',
            'Animated figures',
            toggle('animations', settings.animations, () =>
              onSettings($, s => patchSettings(s, { animations: !s.animations })),
            ),
            'Off shows a still first pose',
          ),
          <Text key="apply" size="caption" dimColor>
            Changes apply from the next workout.
          </Text>,
        ])}

        {card('exercises', [
          <Box key="ex-head" flexDirection="row" justifyContent="space-between" alignItems="center">
            {label('Exercises')}
            <Text size="caption" dimColor tabular>
              {onCount} of {list.length} on
            </Text>
          </Box>,
          ...groups.map(g => (
            <Box key={`group-${g.title}`} flexDirection="column" gap={0}>
              {g.title ? (
                <Text size="footnote" weight="semibold">
                  {g.title}
                </Text>
              ) : null}
              {g.items.map(x => (
                <Box key={`row-${x.id}`} flexDirection="column" paddingLeft={1}>
                  <Button
                    key={`ex-${x.id}`}
                    plain
                    label={`${settings.disabledExercises.includes(x.id) ? '☐' : '☑'} ${x.name}`}
                    onPress={() => onSettings($, s => toggleExercise(s, x.id))}
                  />
                  <Text size="caption" dimColor>
                    {x.description}
                  </Text>
                </Box>
              ))}
            </Box>
          )),
          <Text key="add-own" size="caption" dimColor>
            Add your own exercises in data/exercises.json.
          </Text>,
        ])}
      </Box>
    )
  })

  // ---- The bar above the prompt: drawn only while a workout is active ----

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.surface !== 'desktop') return next(e)
    const workout = await read($, workoutAtom)
    if (!workout) {
      // After a Hardcore workout: offer the prompt it held back in this session.
      const saved = await read($, savedAtom)
      const text = saved?.bySession[await $.session.id()]
      if (!text) return next(e)
      const { Box, Text, Button } = $.ui.resolve(e)
      return (
        <Box flexDirection="row" gap={2} alignItems="center" paddingY={1}>
          <Box flexDirection="column" flexGrow={1} flexShrink={1}>
            <Text size="caption" dimColor>
              Corpore Sano held this prompt during your workout
            </Text>
            <Text size="footnote">{text.length > 160 ? `${text.slice(0, 159)}…` : text}</Text>
          </Box>
          <Button key="discard-saved" label="Discard" variant="secondary" onPress={() => onDiscardSaved($)} />
          <Button key="send-saved" label="Send saved prompt" variant="primary" onPress={() => onSendSaved($)} />
        </Box>
      )
    }
    if (!data) return next(e)
    const ex = findExercise(data, workout.exerciseIds[workout.index] ?? '')
    if (!ex) return next(e)

    const [settings, day, pause, now, turnStartedAt] = await Promise.all([
      read($, settingsAtom),
      read($, dayAtom),
      read($, pauseAtom),
      read($, nowAtom),
      read($, turnAtom),
    ])
    const { Box, Text, Button, Svg } = $.ui.resolve(e)

    const isMatch = workout.level === 'beat-ai'
    const phase = isMatch ? setPhase(workout, now) : null
    const isRest = phase?.phase === 'rest'
    const left = phase ? (phase.phase === 'over' ? 0 : phase.remainingMs) : remainingMs(workout, ex, now)
    const isReady = canFinishExercise(workout, ex, now)
    const nextId = isRest ? upNext(workout) : null
    const nextEx = nextId ? findExercise(data, nextId) : undefined
    const shown = isRest && nextEx ? nextEx : ex
    const working = workingMinutes(day, settings, pause, now)
    const claude = turnStartedAt === null ? '' : ` · Claude working ${Math.floor((now - turnStartedAt) / MINUTE)} min`

    return (
      <Box flexDirection="row" gap={2} alignItems="center" paddingY={1}>
        <Svg
          source={figureSvg(shown, data.bases, { animate: settings.animations && !isRest })}
          alt={`${shown.name}, demonstration`}
          width={72}
          height={84}
          isInteractive
        />
        <Box flexDirection="column" flexGrow={1} flexShrink={1} gap={0}>
          <Box flexDirection="row" gap={1} alignItems="center">
            <Box borderStyle="round" paddingX={1}>
              <Text size="caption" weight="medium">
                {LEVEL_LABEL[workout.level]}
              </Text>
            </Box>
            <Text size="caption" dimColor>
              Working {working} min{claude}
            </Text>
          </Box>
          <Text weight="semibold">{isRest ? (nextEx ? `Rest · next: ${nextEx.name}` : 'Rest') : ex.name}</Text>
          <Text size="footnote">{isRest ? 'Breathe, shake out your arms and legs.' : ex.description}</Text>
          <Text size="caption" dimColor italic>
            {HINT}
          </Text>
          <Text size="caption" tabular>
            {isMatch
              ? `Set ${workout.index + 1} · You ${completedSets(workout, now)} : 0 Claude`
              : progressDots(workout)}
          </Text>
        </Box>
        <Box flexDirection="column" alignItems="flex-end" gap={1}>
          <Text size="title" tabular weight="semibold">
            {clockText(left)}
          </Text>
          {!isMatch && isSecondSide(workout, ex, now) && !isReady ? <Text size="caption">Switch sides</Text> : null}
          {isMatch && workout.isClaudeDone ? <Text size="caption">Last set</Text> : null}
          <Box flexDirection="row" gap={1}>
            {workout.swapsLeft > 0 && !isRest ? (
              <Button
                key="swap"
                label={`Swap (${workout.swapsLeft} left)`}
                variant="secondary"
                onPress={() => onSwap($, workout.id)}
              />
            ) : null}
            {workout.hardcore ? null : (
              <Button key="skip" label="Skip" variant="secondary" onPress={() => onSkip($, workout.id)} />
            )}
            {isMatch ? null : (
              <Button
                key="done"
                label={isReady ? 'Done' : `Done in ${clockText(left)}`}
                variant={isReady ? 'primary' : 'secondary'}
                dimColor={!isReady}
                onPress={() => onDone($, workout.id)}
              />
            )}
          </Box>
        </Box>
      </Box>
    )
  })
}

function statusLine({ settings, day, pause, workout, now }: Snapshot): string {
  if (!settings.enabled) return 'Corpore Sano · off'
  if (pause && pause.until > now) return 'Corpore Sano · paused'
  if (workout?.level === 'beat-ai') return `Corpore Sano · Beat AI match in progress, set ${workout.index + 1}`
  if (workout) return `Corpore Sano · workout in progress, exercise ${workout.index + 1} of ${workout.exerciseIds.length}`
  const left = msUntilDue(day, settings, pause, now)
  if (left === null) return 'Corpore Sano · the counter starts at your first prompt today'
  const working = workingMinutes(day, settings, pause, now)
  const due = left === 0 ? 'workout due, waiting for a longer task' : `workout in ${Math.ceil(left / MINUTE)} min`
  return `Corpore Sano · Working ${working} min · ${due}`
}

