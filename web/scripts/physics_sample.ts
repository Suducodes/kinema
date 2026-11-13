/**
 * Writes a pilot-mode physics file from the synthetic performer, outside the browser, with the same
 * modules the app runs (body reconstruction, physics, the pilot's physics log). Used to exercise
 * live/opensim_crosscheck.py without a camera:
 *   node scripts/physics_sample.mjs <out dir>      (bundled by `npm run physics-sample`)
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { TwinMeta } from '../src/live/assets';
import { Body } from '../src/live/body';
import { Physics } from '../src/live/physics';
import { Demo, PROTOCOL_HOLD_S, PROTOCOL_LEVELS } from '../src/live/demo';
import { LandmarkSmoother } from '../src/live/filters';
import { PhysicsLog } from '../src/live/pilot/physics';

const out = process.argv[2] ?? 'physics-sample';
mkdirSync(out, { recursive: true });
const meta = JSON.parse(readFileSync(join('public', 'live', 'twin.json'), 'utf8')) as TwinMeta;
const body = new Body(meta), phys = new Physics(meta), demo = new Demo(meta, 'protocol'), sm = new LandmarkSmoother(), log = new PhysicsLog(meta);
const heightM = 1.75, massKg = 70;
phys.setMass(massKg);
for (let t = 0; t < 0.3; t += 1 / 30) body.addCalibrationSample(demo.frame(t).frame);
body.finishCalibration(heightM);
const total = PROTOCOL_HOLD_S * PROTOCOL_LEVELS.length;
const windows: [string, number, number][] = [];
for (let k = 0; k < PROTOCOL_LEVELS.length; k++) windows.push([`SIM_${'ABC'[k % 3]}${k < 3 ? 1 : 2}`, k * PROTOCOL_HOLD_S + 2.4, k * PROTOCOL_HOLD_S + 5.4]);
for (let t = 0; t < total; t += 1 / 30) {
  const f = sm.apply(demo.frame(t).frame);
  body.update(f); phys.update(body, t); log.push(t, body, phys, heightM);
  for (const [id, t0, t1] of windows) {
    if (Math.abs(t - t1) < 1 / 60) {
      const w = log.window(t0, t1);
      writeFileSync(join(out, `${id}_physics.csv`), w.csv);
      writeFileSync(join(out, `${id}_physics.json`), JSON.stringify(log.metadata({ hold: id, participant: 'SIM (synthetic performer)', window_s: [t0, t1], frames: w.n,
        height_m: heightM, mass_kg: massKg, source: 'scripts/physics_sample.ts: the demo performer through the app\'s modules, no camera' }, { json: 'n/a (node)', glb: 'n/a (node)' }), null, 1));
      console.log(`${id}: ${w.n} frames`);
    }
  }
}
