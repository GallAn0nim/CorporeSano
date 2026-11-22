#!/usr/bin/env node
// Checks data/exercises.json and renders every figure with hooks/figure.ts.
//   node scripts/check-data.mjs             check only
//   node scripts/check-data.mjs --preview   also write preview.html with every figure
// Needs Node 23.6+ (runs the TypeScript renderer directly).
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { figureSvg } from '../hooks/figure.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const data = JSON.parse(readFileSync(join(root, 'data/exercises.json'), 'utf8'))

const JOINTS = ['h', 'n', 'p', 'e1', 'w1', 'e2', 'w2', 'k1', 'f1', 'k2', 'f2']
const GROUPS = ['upper', 'lower', 'wrist-balance']
const LIMIT = 131_072
const errors = []
const seen = new Set()
const err = (where, msg) => errors.push(`${where}: ${msg}`)

if (data.v !== 1) err('file', 'v must be 1')
for (const [name, pose] of Object.entries(data.bases ?? {})) {
  for (const j of JOINTS) if (!Array.isArray(pose[j]) || pose[j].length !== 2) err(`bases.${name}`, `joint ${j} missing`)
}

const rows = []
for (const level of ['easy', 'hard', 'beatAi']) {
  const list = data[level]
  if (!Array.isArray(list)) {
    err(level, 'missing list')
    continue
  }
  for (const ex of list) {
    const where = `${level}.${ex.id}`
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(ex.id ?? '')) err(where, 'id must be kebab-case')
    if (seen.has(ex.id)) err(where, 'id used twice')
    seen.add(ex.id)
    if (!ex.name || !ex.description) err(where, 'name and description are required')
    if (!data.bases?.[ex.base]) err(where, `unknown base ${ex.base}`)
    if (level !== 'beatAi') {
      if (!GROUPS.includes(ex.group)) err(where, `group must be one of ${GROUPS.join(', ')}`)
      if (!(ex.seconds > 0)) err(where, 'seconds is required on easy and hard')
    }
    if (!(ex.tempoMs > 0)) err(where, 'tempoMs must be positive')
    if (!Array.isArray(ex.keyframes) || ex.keyframes.length === 0) err(where, 'needs at least one keyframe')
    for (const kf of ex.keyframes ?? []) {
      for (const k of Object.keys(kf)) if (!JOINTS.includes(k)) err(where, `unknown joint ${k}`)
    }
    if (errors.length) continue
    const svg = figureSvg(ex, data.bases, { animate: true })
    if (svg.length > LIMIT) err(where, `figure is ${svg.length} characters, over ${LIMIT}`)
    rows.push({ level, ex, svg })
  }
}

if (errors.length) {
  console.error(errors.join('\n'))
  process.exit(1)
}
const longest = Math.max(...rows.map(r => r.svg.length))
console.log(`OK: ${rows.length} exercises, longest figure ${longest} characters (limit ${LIMIT}).`)

if (process.argv.includes('--preview')) {
  const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
  const cards = rows
    .map(
      ({ level, ex, svg }) =>
        `<figure><div class="fig">${svg.replace('width="72" height="84"', 'width="144" height="168"')}</div>` +
        `<figcaption><b>${esc(ex.name)}</b> <small>${level}${ex.group ? ' · ' + ex.group : ''}</small><br>${esc(ex.description)}</figcaption></figure>`,
    )
    .join('\n')
  const html = `<!doctype html><meta charset="utf-8"><title>corpore-sano figures</title>
<style>body{font:14px system-ui;margin:24px;background:#faf9f5;color:#1f1e1d}
@media (prefers-color-scheme: dark){body{background:#1f1e1d;color:#f2f0ea}}
main{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:16px}
figure{margin:0}small{opacity:.6}</style><h1>corpore-sano figures</h1><main>${cards}</main>`
  writeFileSync(join(root, 'preview.html'), html)
  console.log('Wrote preview.html')
}
