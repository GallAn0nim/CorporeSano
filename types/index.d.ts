// corpore-sano: the shared types and the $.state contract.

// ---- Exercise data (data/exercises.json) ----

export type Point = [x: number, y: number]

// h head centre, n neck/shoulder, p pelvis, e elbow, w wrist, k knee, f foot
// 1 = near side (full colour), 2 = far side (muted)
export type Joint = 'h' | 'n' | 'p' | 'e1' | 'w1' | 'e2' | 'w2' | 'k1' | 'f1' | 'k2' | 'f2'

export type Pose = Record<Joint, Point>

export type BaseName = 'stand' | 'seated' | 'quadruped' | 'plank' | 'supine' | 'prone' | 'sideLying'

export type Group = 'upper' | 'lower' | 'wrist-balance'

export type Exercise = {
  /** kebab-case, unique across levels */
  id: string
  name: string
  /** one line, shown in the bar */
  description: string
  /** easy and hard only */
  group?: Group
  /** easy and hard; beat-ai is always 40 */
  seconds?: number
  /** the bar shows "Switch sides" at half time */
  perSide?: boolean
  base: BaseName
  props?: {
    chair?: { x: number; facing: 'right' | 'left' }
    desk?: { x: number }
    wall?: { x: number }
  }
  arrow?: [x1: number, y1: number, x2: number, y2: number]
  /** time from one keyframe to the next */
  tempoMs: number
  /** 2 = back and forth, 3+ = a loop */
  keyframes: Partial<Pose>[]
}

export type ExerciseFile = {
  v: 1
  bases: Record<BaseName, Pose>
  easy: Exercise[]
  hard: Exercise[]
  beatAi: Exercise[]
}

// ---- Store values (every key prefixed cs., every value carries v: 1) ----

export type Level = 'easy' | 'hard' | 'beat-ai'

/** cs.settings */
export type Settings = {
  v: 1
  enabled: boolean
  level: Level
  hardcore: boolean
  /** 15–120 */
  workMinutes: number
  /** 0–10 */
  swapsPerWorkout: number
  animations: boolean
  disabledExercises: string[]
}

/** cs.pause: epoch ms the mod turns itself back on */
export type Pause = { v: 1; until: number }

/** cs.day */
export type Day = {
  v: 1
  /** local date, YYYY-MM-DD */
  date: string
  /** epoch ms the work counter last started */
  workStart: number
  beaten: number
  failed: number
  lastScore?: string
  /** the workStart a "workout due" toast was already shown for */
  dueNotified?: number
}

export type WorkoutResult = 'finished' | 'skipped' | 'failed'

/** cs.workout: the active workout */
export type Workout = {
  v: 1
  id: string
  level: Level
  hardcore: boolean
  exerciseIds: string[]
  index: number
  startedAt: number
  exerciseStartedAt: number
  swapsLeft: number
  savedPrompt?: string
  /** beat-ai: the enabled list the match rotates through */
  rotation?: string[]
  /** beat-ai: index into `rotation` of the current set's place */
  pointer?: number
  /** beat-ai: the agent's turn completed, so this set is the last */
  isClaudeDone?: boolean
  /** beat-ai: the session whose turn the match plays against; only its turn ends it */
  sessionId?: string
}

/** cs.saved: prompts Hardcore held back, per session, sent with "Send saved prompt" */
export type Saved = { v: 1; bySession: Record<string, string> }

/** cs.bag: the Hardcore shuffle bags */
export type Bag = { v: 1; easy: string[]; hard: string[] }

/** cs.last: the previous workout per level */
export type Last = { v: 1; easy: string[]; hard: string[]; beatAiIndex: number }

// Aliases for the contract below: inside `declare module 'claude-code'` the
// engine's own names (it has a `Settings` too) shadow this file's.
export type CsSettings = Settings
export type CsDay = Day
export type CsPause = Pause
export type CsWorkout = Workout
export type CsSaved = Saved

declare module 'claude-code' {
  interface PluginState {
    // Session mirrors of the store, so the bar and pane redraw when they change.
    'corpore-sano': {
      settings: CsSettings
      day: CsDay | null
      pause: CsPause | null
      workout: CsWorkout | null
      /** when this session's running turn started, or null between turns */
      turnStartedAt: number | null
      /** the panel is asking how long to turn off for */
      isAskingPause: boolean
      /** Hardcore: "I give up" was typed, so turning off is allowed */
      isGivingUp: boolean
      /** held-back prompts, mirrored from cs.saved */
      saved: CsSaved | null
      /** the clock at the last poll, so "Working" redraws as time passes */
      now: number
    }
  }
}
