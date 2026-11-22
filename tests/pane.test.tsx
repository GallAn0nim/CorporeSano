import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { localDate, timeText } from '../hooks/logic'
import { FIXTURE } from './fixtures/exercises'

const MIN = 60_000
const T0 = new Date(2026, 2, 10, 9, 0, 0).getTime()

const PANE = {
  plugin: 'corpore-sano',
  component: 'Pane',
  requestId: 'corpore-sano',
  props: {
    title: 'Corpore Sano',
    isFocused: false,
    bodyColumns: 48,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const day = (workStart: number, extra: object = {}) => ({
  v: 1,
  date: localDate(workStart),
  workStart,
  beaten: 0,
  failed: 0,
  ...extra,
})

function world(on: On, now: number, store: Record<string, unknown>, isOpenMocked = true) {
  const clock = mock.clock(on, { now })
  mock.store(on, store)
  on('command.register', () => ({ value: { command: 'corpore-sano' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('fs.read', () => ({ value: JSON.stringify(FIXTURE) }))
  on('ui.toast', () => ({ value: undefined }))
  if (isOpenMocked) on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.render', ($, e) => $.ui.resolve(e).Text({ children: '' }))
  return { clock }
}

type Ui = { find: (q: { type: string; text?: RegExp; key?: string }) => Promise<{ text?: string; props: Record<string, unknown> } | undefined> }
const text = async (ui: Ui, re: RegExp) => (await ui.find({ type: 'Text', text: re }))?.text
const label = async (ui: Ui, key: string) => (await ui.find({ type: 'Button', key }))?.props.label

test('/corpore-sano opens the panel', async ($, on) => {
  world(on, T0, {}, false)
  const opened: string[] = []
  on('ui.open', (_, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const r = await $.command.run({
    command: 'corpore-sano',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 80 },
  })
  expect(opened).toEqual(['corpore-sano'])
  expect(r).toEqual(expect.objectContaining({ text: 'Corpore Sano panel opened.' }))
})

test('the panel shows Working, today and the exercise list', async ($, on) => {
  world(on, T0 + 12 * MIN, { 'cs.day': day(T0, { beaten: 4, failed: 1 }) })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  expect(await text(ui, /^12 min$/)).toBe('12 min')
  expect(await text(ui, /beaten/)).toBe('exercises beaten · 1 workout failed')
  expect(await text(ui, /^4$/)).toBe('4')
  expect(await text(ui, /of \d+ on$/)).toBe('7 of 7 on')
  expect(await label(ui, 'ex-u1')).toBe('☑ u1')
  expect(await text(ui, /not medical advice/)).toContain('physiotherapist')
  await ui.unmount()
})

test('unticking an exercise and changing the level are saved', async ($, on) => {
  world(on, T0 + 12 * MIN, { 'cs.day': day(T0) })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  await ui.press({ key: 'ex-u1' })
  expect(await label(ui, 'ex-u1')).toBe('☐ u1')
  expect(await text(ui, /of \d+ on$/)).toBe('6 of 7 on')

  await ui.select({ key: 'level', value: 'hard' })
  expect(await label(ui, 'ex-hu')).toBe('☑ hu')
  expect(await text(ui, /Comfortable clothes/)).toContain('Comfortable clothes needed.')

  await ui.select({ key: 'work-minutes', value: '30' })
  expect(await text(ui, /workout in/)).toBe('Next workout in 18 min')
  await ui.unmount()
})

test('turning off for 1 h, then it turns itself back on with Working reset', async ($, on) => {
  const now = T0 + 20 * MIN
  const { clock } = world(on, now, { 'cs.day': day(T0) })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  await ui.press({ key: 'off' })
  expect(await label(ui, 'off-1h')).toBe('1 h')
  await ui.press({ key: 'off-1h' })
  expect(await text(ui, /^Off until/)).toBe(`Off until ${timeText(now + 60 * MIN)}`)
  expect(await text(ui, /^\d+ min$/)).toBe('0 min')

  await clock.advance(60 * MIN + 10_000) // the poll at 60 min turns it back on
  expect(await text(ui, /^On$/)).toBe('On')
  expect(await text(ui, /^\d+ min$/)).toBe('0 min')
  expect(await text(ui, /workout in/)).toBe('Next workout in 45 min')
  await ui.unmount()
})

test('Turn on during a pause resets Working', async ($, on) => {
  const now = T0 + 50 * MIN
  world(on, now, { 'cs.day': day(T0), 'cs.pause': { v: 1, until: now + 30 * MIN } })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  await ui.press({ key: 'on' })
  expect(await text(ui, /^On$/)).toBe('On')
  expect(await text(ui, /workout in/)).toBe('Next workout in 45 min')
  await ui.unmount()
})
