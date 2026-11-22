// A small exercise file for tests (the real one is data/exercises.json).
import type { Exercise, ExerciseFile, Group, Pose } from '../../types'

const stand: Pose = {
  h: [50, 15], n: [50, 25], p: [50, 52], e1: [50, 38], w1: [50, 50], e2: [50, 38], w2: [50, 50],
  k1: [50, 72], f1: [50, 92], k2: [50, 72], f2: [50, 92],
}

const ex = (id: string, group: Group, seconds = 30, extra: Partial<Exercise> = {}): Exercise => ({
  id,
  name: id.replace(/-/g, ' '),
  description: `Do ${id}.`,
  group,
  seconds,
  base: 'stand',
  tempoMs: 1000,
  keyframes: [{}, { h: [52, 20] }],
  ...extra,
})

export const FIXTURE: ExerciseFile = {
  v: 1,
  bases: { stand, seated: stand, quadruped: stand, plank: stand, supine: stand, prone: stand, sideLying: stand },
  easy: [
    ex('u1', 'upper'), ex('u2', 'upper'), ex('u3', 'upper'),
    ex('l1', 'lower', 40, { perSide: true }), ex('l2', 'lower'),
    ex('w1', 'wrist-balance'), ex('w2', 'wrist-balance'),
  ],
  hard: [ex('hu', 'upper'), ex('hl', 'lower'), ex('hw', 'wrist-balance')],
  beatAi: [
    { ...ex('push-ups', 'upper'), group: undefined, seconds: undefined },
    { ...ex('squats', 'lower'), group: undefined, seconds: undefined },
    { ...ex('plank', 'upper'), group: undefined, seconds: undefined },
  ],
}
