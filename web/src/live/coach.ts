import type { Body, Side } from './body';
import type { Physics } from './physics';

/**
 * Exercise coach: counts reps and scores each one from the reconstructed body and physics.
 * Cues are movement observations (depth, knees drifting in, uneven loading, trunk lean, landing
 * softness), not medical advice.
 */
export type Mode = 'free' | 'squat' | 'lunge' | 'single' | 'jump';

export interface Rep {
  n: number; depth: number; valgus: number; trunk: number; asym: number; down: number; up: number;
  side?: Side; landing?: { peakKnee: number; valgus: number; asym: number };
}
export interface Cue { level: 'good' | 'warn'; text: string }

const TOP = 22, ENTER = 38;

export class Coach {
  mode: Mode = 'free';
  reps: Rep[] = [];
  phase = 'ready';
  cues: Cue[] = [];
  private inRep = false;
  private start = 0; private peakT = 0;
  private cur = { depth: 0, valgus: 0, trunk: 0, loadR: 0, loadL: 0, n: 0, side: 'R' as Side };
  /** (signal, right, left knee extensor moment) through the rep: unevenness is judged near the bottom. */
  private trace: [number, number, number][] = [];
  private air = false; private airT = 0; private landT = 0; private landing: Rep['landing'] | null = null;

  setMode(m: Mode) { this.mode = m; this.reps = []; this.inRep = false; this.phase = 'ready'; this.cues = []; this.landing = null; }

  update(body: Body, phys: Physics, t: number) {
    const A = body.angles, tau = (s: Side) => Math.max(0, -phys.res[s].tau.knee_flex);   // knee extensor demand
    if (this.mode === 'free') { this.phase = 'free movement'; this.cues = []; return; }
    if (this.mode === 'jump') return this.jump(body, phys, t);
    let signal: number, valgus: number, side: Side = 'R';
    if (this.mode === 'single') {
      side = body.footMinY.R < body.footMinY.L ? 'R' : 'L';
      signal = A[side].knee_flex; valgus = A[side].valgus;
    } else {
      signal = this.mode === 'lunge' ? Math.max(A.R.knee_flex, A.L.knee_flex) : (A.R.knee_flex + A.L.knee_flex) / 2;
      valgus = Math.max(A.R.valgus, A.L.valgus);
      if (this.mode === 'lunge') side = A.R.hip_flex > A.L.hip_flex ? 'R' : 'L';
    }
    if (!this.inRep && signal > ENTER) {
      this.inRep = true; this.start = t; this.peakT = t;
      this.cur = { depth: 0, valgus: -99, trunk: 0, loadR: 0, loadL: 0, n: 0, side };
      this.trace = [];
    }
    if (this.inRep) {
      const c = this.cur;
      if (signal > c.depth) { c.depth = signal; this.peakT = t; c.side = side; }
      c.valgus = Math.max(c.valgus, valgus);
      c.trunk = Math.max(c.trunk, body.trunkLean);
      this.trace.push([signal, tau('R'), tau('L')]);
      this.phase = t - this.peakT < 0.15 && signal >= c.depth - 1 ? 'going down' : 'coming up';
      if (signal < TOP) {
        this.inRep = false;
        // knee work per leg over the bottom of the rep (signal within 80 % of the deepest point)
        for (const [sig, r, l] of this.trace) if (sig >= 0.8 * c.depth) { c.loadR += r; c.loadL += l; c.n++; }
        const mean = (c.loadR + c.loadL) / 2;
        const rep: Rep = { n: this.reps.length + 1, depth: c.depth, valgus: c.valgus, trunk: c.trunk,
          asym: mean > 1 ? (Math.abs(c.loadR - c.loadL) / mean) * 100 : 0, down: this.peakT - this.start, up: t - this.peakT, side: c.side };
        if (this.mode === 'lunge' || this.mode === 'single') rep.asym = 0;
        this.reps.push(rep);
        this.cues = this.judge(rep);
      }
    } else this.phase = 'ready';
  }

  private jump(body: Body, phys: Physics, t: number) {
    const airborne = !body.contact.R && !body.contact.L && Math.min(body.footMinY.R, body.footMinY.L) > 0.05;
    if (airborne && !this.air) { this.air = true; this.airT = t; this.phase = 'in the air'; }
    if (!airborne && this.air && t - this.airT > 0.12) {
      this.air = false; this.landT = t; this.phase = 'landing';
      this.landing = { peakKnee: 0, valgus: -99, asym: 0 };
      this.cur = { depth: 0, valgus: -99, trunk: 0, loadR: 0, loadL: 0, n: 0, side: 'R' };
    }
    if (this.landing && t - this.landT < 0.45) {
      const A = body.angles, L = this.landing;
      L.peakKnee = Math.max(L.peakKnee, (A.R.knee_flex + A.L.knee_flex) / 2);
      L.valgus = Math.max(L.valgus, A.R.valgus, A.L.valgus);
      this.cur.loadR += Math.max(0, -phys.res.R.tau.knee_flex); this.cur.loadL += Math.max(0, -phys.res.L.tau.knee_flex);
    } else if (this.landing) {
      const mean = (this.cur.loadR + this.cur.loadL) / 2;
      this.landing.asym = mean > 1 ? (Math.abs(this.cur.loadR - this.cur.loadL) / mean) * 100 : 0;
      const rep: Rep = { n: this.reps.length + 1, depth: this.landing.peakKnee, valgus: this.landing.valgus, trunk: body.trunkLean,
        asym: this.landing.asym, down: 0, up: 0, landing: this.landing };
      this.reps.push(rep);
      this.cues = this.judge(rep);
      this.landing = null; this.phase = 'ready';
    } else if (!this.air) this.phase = 'ready';
  }

  private judge(r: Rep): Cue[] {
    const out: Cue[] = [];
    if (r.landing) {
      out.push(r.depth < 45 ? { level: 'warn', text: `Stiff landing: knees bent only ${r.depth.toFixed(0)}°. Bend more to absorb it.` }
        : { level: 'good', text: `Soft landing: knees bent to ${r.depth.toFixed(0)}°.` });
    } else {
      const label = r.depth < 60 ? 'quarter' : r.depth < 90 ? 'half' : r.depth < 110 ? 'parallel' : 'deep';
      out.push({ level: r.depth < 60 ? 'warn' : 'good', text: `Depth ${r.depth.toFixed(0)}° knee bend (${label}).` });
      if (r.down + r.up > 0) out.push({ level: 'good', text: `Tempo ${r.down.toFixed(1)} s down, ${r.up.toFixed(1)} s up.` });
    }
    if (r.valgus > 8) out.push({ level: 'warn', text: `Knee drifting inward (${r.valgus.toFixed(0)}°). Push the knees out over the toes.` });
    if (r.asym > 15) out.push({ level: 'warn', text: `Uneven: one leg did ${r.asym.toFixed(0)}% more of the knee work.` });
    if (r.trunk > 50) out.push({ level: 'warn', text: `Chest dropping forward (${r.trunk.toFixed(0)}° trunk lean).` });
    if (out.every((c) => c.level === 'good')) out.push({ level: 'good', text: 'Clean rep.' });
    return out;
  }
}
