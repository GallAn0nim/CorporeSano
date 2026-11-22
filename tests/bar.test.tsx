import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { localDate } from '../hooks/logic'
import { FIXTURE } from './fixtures/exercises'

const MIN = 60_000
const T0 = new Date(2026, 2, 10, 9, 0, 0).getTime()

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

const day = (workStart: number) => ({ v: 1, date: localDate(workStart), workStart, beaten: 0, failed: 0 })

const workout = (startedAt: number, extra: object = {}) => ({
  v: 1,
  id: 'w-1',
  level: 'easy',
  hardcore: false,
  exerciseIds: ['u1', 'l1', 'w1'],
  index: 0,
  startedAt,
  exerciseStartedAt: startedAt,
  swapsLeft: 3,
  ...extra,
})

/** The engine beneath the plugin: store, clock, data file, toasts. */
function world(on: On, now: number, store: Record<string, unknown>) {
  const clock = mock.clock(on, { now })
  mock.store(on, store)
  const toasts: string[] = []
  on('command.register', () => ({ value: { command: 'corpore-sano' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('fs.read', () => ({ value: JSON.stringify(FIXTURE) }))
  // A surface without panes: the command answers with the status line.
  on('ui.open', () => ({ value: { isPlaced: false, reason: 'no pane surface' } }))
  // What the engine draws when the plugin passes: an empty row.
  on('ui.render', ($, e) => $.ui.resolve(e).Text({ children: '' }))
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  return { clock, toasts }
}

const text = async (ui: { find: (q: { type: 'Text'; text: RegExp }) => Promise<{ text?: string } | undefined> }, re: RegExp) =>
  (await ui.find({ type: 'Text', text: re }))?.text

test('no workout: the bar draws nothing of its own', async ($, on) => {
  world(on, T0 + 10 * MIN, { 'cs.day': day(T0) })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount(BAR)
  expect(await text(ui, /Corpore Sano|Working/)).toBe(undefined)
  await ui.unmount()
})

test('the workout bar: timer, dots, Done after the timer, then the next exercise', async ($, on) => {
  const start = T0 + 46 * MIN
  const { clock } = world(on, start, { 'cs.day': day(T0), 'cs.workout': workout(start) })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount(BAR)

  expect(await text(ui, /^u1$/)).toBe('u1')
  expect(await text(ui, /^Easy$/)).toBe('Easy')
  expect(await text(ui, /^0:30$/)).toBe('0:30')
  expect(await text(ui, /^[●○]+$/)).toBe('●○○')
  expect(await text(ui, /distance/)).toBe('Look into the distance for a few seconds.')

  // Done before the timer runs out does nothing.
  await ui.press({ key: 'done' })
  expect(await text(ui, /^u1$/)).toBe('u1')

  await clock.advance(30_000)
  expect(await text(ui, /^0:00$/)).toBe('0:00')
  await ui.press({ key: 'done' })
  expect(await text(ui, /^l1$/)).toBe('l1')
  expect(await text(ui, /^[●○]+$/)).toBe('●●○')
  expect(await text(ui, /^0:40$/)).toBe('0:40')

  // l1 is per side: half way the bar says so.
  await clock.advance(20_000)
  expect(await text(ui, /Switch sides/)).toBe('Switch sides')
  await ui.unmount()
})

test('Swap replaces the exercise and counts down the swaps', async ($, on) => {
  const start = T0 + 46 * MIN
  world(on, start, { 'cs.day': day(T0), 'cs.workout': workout(start) })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount(BAR)

  await ui.press({ key: 'swap' })
  const name = await text(ui, /^u[23]$/)
  expect(name === 'u2' || name === 'u3').toBe(true)
  expect((await ui.find({ type: 'Button', key: 'swap' }))?.props.label).toBe('Swap (2 left)')
  await ui.unmount()
})

test('Skip ends the workout and resets the work counter', async ($, on) => {
  const start = T0 + 46 * MIN
  const { toasts } = world(on, start, { 'cs.day': day(T0), 'cs.workout': workout(start) })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount(BAR)

  await ui.press({ key: 'skip' })
  expect(await text(ui, /^u1$/)).toBe(undefined)
  expect(toasts).toContain('Corpore Sano: workout skipped.')
  expect((await $.command.run({
      command: 'corpore-sano',
      args: '',
      origin: { kind: 'composer' },
      presentation: { isFullscreen: false, columns: 80 },
    }))).toEqual(
    expect.objectContaining({ text: 'Corpore Sano · Working 0 min · workout in 45 min' }),
  )
  await ui.unmount()
})

test('due for 10 minutes without a long turn: the poll starts the workout', async ($, on) => {
  const { clock } = world(on, T0 + 45 * MIN, { 'cs.day': day(T0) })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount(BAR)
  expect(await text(ui, /^[●○]+$/)).toBe(undefined)

  await clock.advance(9 * MIN) // 54 min of work: due for 9 min, still waiting
  expect(await text(ui, /^[●○]+$/)).toBe(undefined)
  await clock.advance(1 * MIN)
  expect(await text(ui, /^[●○]+$/)).toBe('●○○')
  await ui.unmount()
})

const run = (args: string) => ({
  command: 'corpore-sano',
  args,
  origin: { kind: 'composer' as const },
  presentation: { isFullscreen: false, columns: 80 },
})

test('developer arguments work only with CORPORE_SANO_DEV=1', async ($, on) => {
  world(on, T0 + 10 * MIN, { 'cs.day': day(T0) })
  mock.env(on, { CORPORE_SANO_DEV: '1' })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount(BAR)

  expect(await $.command.run(run('show w2'))).toEqual(
    expect.objectContaining({ text: expect.stringContaining('Showing w2.') }),
  )
  expect(await text(ui, /^w2$/)).toBe('w2')
  await ui.unmount()
})

test('without CORPORE_SANO_DEV the command only opens the panel', async ($, on) => {
  world(on, T0 + 10 * MIN, { 'cs.day': day(T0) })
  mock.env(on, {})
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount(BAR)

  expect(await $.command.run(run('start'))).toEqual(
    expect.objectContaining({ text: 'Corpore Sano · Working 10 min · workout in 35 min' }),
  )
  expect(await text(ui, /^[●○]+$/)).toBe(undefined)
  await ui.unmount()
})
