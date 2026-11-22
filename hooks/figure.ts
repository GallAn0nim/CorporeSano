// Pose interpolation and the SMIL figure renderer (see the build spec, SVG animation).
import type { Exercise, ExerciseFile, Joint, Pose } from '../types'

const FAR: [Joint, Joint][] = [['n', 'e2'], ['e2', 'w2'], ['p', 'k2'], ['k2', 'f2']]
const NEAR: [Joint, Joint][] = [['n', 'p'], ['p', 'k1'], ['k1', 'f1'], ['n', 'e1'], ['e1', 'w1']]
const EASE = '0.42 0 0.58 1'   // ease-in-out between every pair of keyframes

const STYLE = `<style>
  line, path { stroke-width: 3; stroke-linecap: round; fill: none }
  .near { stroke: #1f1e1d } .far { stroke: #a3a09a } .prop { stroke: #c9c6bd; stroke-width: 2 }
  .floor { stroke: #c9c6bd; stroke-width: 1 } .arrow { stroke: #2f9e6e; stroke-width: 2 }
  @media (prefers-color-scheme: dark) {
    .near { stroke: #f2f0ea } .far { stroke: #7d7a73 } .prop, .floor { stroke: #55534e }
  }
</style>`

export const framesOf = (ex: Exercise, bases: ExerciseFile['bases']): Pose[] =>
  ex.keyframes.map(kf => ({ ...bases[ex.base], ...kf }) as Pose)

// One <animate> per changing attribute; the cycle returns to the first frame.
const anim = (attr: string, vals: number[], durMs: number): string => {
  if (vals.every(v => v === vals[0])) return ''
  const n = vals.length - 1
  const keyTimes = vals.map((_, i) => +(i / n).toFixed(4)).join(';')
  return `<animate attributeName="${attr}" values="${vals.join(';')}" keyTimes="${keyTimes}"`
    + ` calcMode="spline" keySplines="${Array(n).fill(EASE).join(';')}" dur="${durMs}ms" repeatCount="indefinite"/>`
}

const limb = (fs: Pose[], [a, b]: [Joint, Joint], cls: string, dur: number, on: boolean): string => {
  const f = fs[0]!
  const kids = on
    ? anim('x1', fs.map(p => p[a][0]), dur) + anim('y1', fs.map(p => p[a][1]), dur)
      + anim('x2', fs.map(p => p[b][0]), dur) + anim('y2', fs.map(p => p[b][1]), dur)
    : ''
  return `<line class="${cls}" x1="${f[a][0]}" y1="${f[a][1]}" x2="${f[b][0]}" y2="${f[b][1]}">${kids}</line>`
}

const props = (ex: Exercise): string => {
  const out: string[] = ['<line class="floor" x1="4" y1="93" x2="96" y2="93"/>']
  const { chair, desk, wall } = ex.props ?? {}
  if (chair) {
    const s = chair.facing === 'right' ? 18 : -18
    out.push(`<path class="prop" d="M${chair.x} 40 V93 M${chair.x} 60 H${chair.x + s} V93"/>`)
  }
  if (desk) out.push(`<path class="prop" d="M${desk.x} 52 H${desk.x + 26} M${desk.x + 22} 52 V93"/>`)
  if (wall) out.push(`<line class="prop" x1="${wall.x}" y1="0" x2="${wall.x}" y2="93"/>`)
  return out.join('')
}

export function figureSvg(ex: Exercise, bases: ExerciseFile['bases'], opts: { animate: boolean }): string {
  const frames = framesOf(ex, bases)
  if (frames.length === 0) frames.push({ ...bases[ex.base] })
  const f = frames[0]!
  const fs = [...frames, f]                       // close the loop
  const dur = ex.tempoMs * frames.length
  const on = opts.animate && frames.length > 1
  const head = `<circle class="near" cx="${f.h[0]}" cy="${f.h[1]}" r="6" fill="none" stroke-width="3">`
    + (on ? anim('cx', fs.map(p => p.h[0]), dur) + anim('cy', fs.map(p => p.h[1]), dur) : '') + '</circle>'
  const arrow = ex.arrow
    ? `<line class="arrow" x1="${ex.arrow[0]}" y1="${ex.arrow[1]}" x2="${ex.arrow[2]}" y2="${ex.arrow[3]}" marker-end="url(#cs-arrow)"/>`
    : ''
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="72" height="84">' + STYLE
    + '<defs><marker id="cs-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto">'
    + '<path d="M2 1L8 5L2 9" stroke="#2f9e6e" stroke-width="2" fill="none"/></marker></defs>'
    + props(ex)
    + FAR.map(l => limb(fs, l, 'far', dur, on)).join('')
    + NEAR.map(l => limb(fs, l, 'near', dur, on)).join('')
    + head + arrow + '</svg>'
}
