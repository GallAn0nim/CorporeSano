#!/usr/bin/env node
// Writes docs/figures.svg: every exercise's animated figure in one grid, for the README.
//   node scripts/gallery.mjs        (Node 23.6+)
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { figureSvg } from '../hooks/figure.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const data = JSON.parse(readFileSync(join(root, 'data/exercises.json'), 'utf8'))
const all = ['easy', 'hard', 'beatAi'].flatMap(level => data[level])
const COLS = 11, W = 90, H = 100
const cells = all.map((ex, i) =>
  figureSvg(ex, data.bases, { animate: true })
    // Each figure carries its own marker id; keep them unique in one document.
    .replaceAll('cs-arrow', `cs-arrow-${i}`)
    .replace('width="72" height="84"', `x="${(i % COLS) * W}" y="${Math.floor(i / COLS) * H}" width="${W}" height="${H}"`),
)
const rows = Math.ceil(all.length / COLS)
writeFileSync(
  join(root, 'docs/figures.svg'),
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${COLS * W} ${rows * H}" width="${COLS * W}" height="${rows * H}">${cells.join('')}</svg>\n`,
)
console.log(`Wrote docs/figures.svg (${all.length} figures).`)
