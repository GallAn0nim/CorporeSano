import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import {
  DEFAULT_SETTINGS,
  EMPTY_SAVED,
  blockPrompt,
  isGiveUp,
  localDate,
  savePrompt,
  startWorkout,
  takeSaved,
} from '../hooks/logic'
import { FIXTURE } from './fixtures/exercises'

const MIN = 60_000
const T0 = new Date(2026, 2, 10, 9, 0, 0).getTime()
const HC = { ...DEFAULT_SETTINGS, hardcore: true }
const hardcoreWorkout = (extra: object = {}) => ({
  ...startWorkout('easy', HC, ['u1', 'l1', 'w1'], T0, () => 0),
  id: 'w-1',
  ...extra,
})
const person = { kind: 'composer' }
const plain = { isCommand: false, isMeta: false }

describe('blockPrompt', () => {
  test('holds the person’s prompts during a Hardcore workout', async () => {
    expect(blockPrompt(hardcoreWorkout({ index: 1 }), person, plain, T0)).toBe(
      'Finish your workout first: 1 of 3 done.',
    )
    expect(blockPrompt(hardcoreWorkout(), { kind: 'sdk' }, plain, T0)).not.toBe(null)
  })
  test('lets through: no workout, Hardcore off, commands, hidden prompts, the mod’s own', async () => {
    expect(blockPrompt(null, person, plain, T0)).toBe(null)
    expect(blockPrompt({ ...hardcoreWorkout(), hardcore: false }, person, plain, T0)).toBe(null)
    expect(blockPrompt(hardcoreWorkout(), person, { isCommand: true, isMeta: false }, T0)).toBe(null)
    expect(blockPrompt(hardcoreWorkout(), person, { isCommand: false, isMeta: true }, T0)).toBe(null)
    expect(blockPrompt(hardcoreWorkout(), { kind: 'plugin' }, plain, T0)).toBe(null)
    expect(blockPrompt(hardcoreWorkout(), { kind: 'task-notification' }, plain, T0)).toBe(null)
  })
  test('on beat-ai the reason gives the match so far', async () => {
    const w = { ...startWorkout('beat-ai', HC, ['squats'], T0, () => 0), index: 2 }
    expect(blockPrompt(w, person, plain, T0 + 45_000)).toBe('Finish your workout first: set 3, You 3 : 0 Claude.')
  })
})

describe('saved prompts', () => {
  test('kept per session, joined, taken out once', async () => {
    let s = savePrompt(EMPTY_SAVED, 'a', 'fix the tests')
    s = savePrompt(s, 'a', 'and the README')
    s = savePrompt(s, 'b', 'other session')
    const taken = takeSaved(s, 'a')
    expect(taken.text).toBe('fix the tests\n\nand the README')
    expect(taken.saved.bySession).toEqual({ b: 'other session' })
    expect(takeSaved(taken.saved, 'a').text).toBe(null)
  })
  test('the give-up phrase', async () => {
    expect(isGiveUp('I give up')).toBe(true)
    expect(isGiveUp('  i  give up! ')).toBe(true)
    expect(isGiveUp('I give')).toBe(false)
  })
})

// ---- In the engine ----

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

const PANE = {
  plugin: 'corpore-sano',
  component: 'Pane',
  requestId: 'corpore-sano',
  surface: 'desktop',
  props: {
    title: 'Corpore Sano',
    isFocused: false,
    bodyColumns: 48,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const day = { v: 1, date: localDate(T0), workStart: T0 - 46 * MIN, beaten: 0, failed: 0 }

function world(on: On, store: Record<string, unknown>) {
  const clock = mock.clock(on, { now: T0 })
  mock.store(on, store)
  const toasts: string[] = []
  const submitted: string[] = []
  on('command.register', () => ({ value: { command: 'corpore-sano' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'session-a' }))
  on('fs.read', () => ({ value: JSON.stringify(FIXTURE) }))
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.render', ($, e) => $.ui.resolve(e).Text({ children: '' }))
  on('prompt.submit', (_, e) => {
    submitted.push(e.text)
    return { text: e.text }
  })
  return { clock, toasts, submitted }
}

type Ui = {
  find: (q: { type: string; text?: RegExp; key?: string }) => Promise<{ text?: string; props: Record<string, unknown> } | undefined>
}
const text = async (ui: Ui, re: RegExp) => (await ui.find({ type: 'Text', text: re }))?.text
const has = async (ui: Ui, type: string, key: string) => (await ui.find({ type, key })) !== undefined

test('a prompt during a Hardcore workout is held, then sent after it', async ($, on) => {
  const { clock, submitted } = world(on, { 'cs.day': day, 'cs.workout': hardcoreWorkout({ exerciseIds: ['u1'] }) })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount(BAR)
  expect(await has(ui, 'Button', 'skip')).toBe(false)

  const r = await $.prompt.submit({ text: 'refactor the parser', origin: { kind: 'composer' }, wait: false })
  expect(r).toEqual({ drop: 'Finish your workout first: 0 of 1 done.' })
  expect(submitted).toEqual([])

  await clock.advance(30_000)
  await ui.press({ key: 'done' })
  expect(await text(ui, /held this prompt/)).toBe('Corpore Sano held this prompt during your workout')
  expect(await text(ui, /refactor/)).toBe('refactor the parser')

  await ui.press({ key: 'send-saved' })
  expect(submitted).toEqual(['refactor the parser'])
  expect(await has(ui, 'Button', 'send-saved')).toBe(false)
  await ui.unmount()
})

test('turning off during a Hardcore workout needs I give up and counts a failed workout', async ($, on) => {
  const { toasts } = world(on, { 'cs.day': day, 'cs.workout': hardcoreWorkout() })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount(PANE)

  await ui.press({ key: 'off' })
  expect(await has(ui, 'Button', 'off-1h')).toBe(false)
  await ui.input({ key: 'give-up', text: 'nope' })
  expect(toasts).toContain('Type exactly: I give up')
  expect(await has(ui, 'Button', 'off-1h')).toBe(false)

  await ui.input({ key: 'give-up', text: 'I give up' })
  expect(await text(ui, /counts as failed/)).toBe('The workout in progress counts as failed.')
  await ui.press({ key: 'off-1h' })
  expect(await text(ui, /^Off until/)).toBeDefined()
  expect(await text(ui, /beaten/)).toBe('exercises beaten · 1 workout failed')
  expect(toasts).toContain('Corpore Sano: workout failed.')
  await ui.unmount()
})
