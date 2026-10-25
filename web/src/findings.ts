/** "Findings": the question, how OpenSim models it, the work done, and what the simulations found. */
import { MUSCLE_ORDER, SHORT, type AtlasEntry } from './atlas';

interface Manifest {
  validation?: Record<string, { rmse: number; r: number }>;
  dial?: { s: number; effort_ratio?: number; step_s?: number }[];
  atlas?: (AtlasEntry & { phrase?: string })[];
  stats?: { solves: number; converged: number; cpu_hours: number };
  notice?: string;
}

const pct = (s: number) => `${Math.round(s * 100)}%`;
const x = (r: number) => `×${r.toFixed(r >= 10 ? 0 : 1)}`;

function topCompensators(e: AtlasEntry, n = 3) {
  return MUSCLE_ORDER.filter((m) => !e.weakened.includes(m))
    .map((m) => [m, e.fingerprint[m] ?? 1] as const)
    .sort((a, b) => b[1] - a[1]).slice(0, n);
}

export function findingsHtml(m: Manifest) {
  const v = m.validation, calves = m.atlas?.find((e) => e.id === 'plantarflexors');
  const others = (m.atlas ?? []).filter((e) => e.id !== 'plantarflexors' && e.converged);
  const dial = [...(m.dial ?? [])].filter((d) => d.effort_ratio != null).sort((a, b) => b.s - a.s);
  const maxE = Math.max(...dial.map((d) => d.effort_ratio!), 1);
  const stats = m.stats;

  return `
  <h2>Findings</h2>
  <p class="lede">What we built, how OpenSim models the body, and what the simulations found.</p>
  ${m.notice ? `<p class="notice">${m.notice}</p>` : ''}

  <h3>The question</h3>
  <p>When one muscle group gets weak, how does the whole body re-organise its walk: which muscles take over, and
  what does it cost? Earlier modelling studies weakened muscles while <b>holding the walking pattern fixed</b>
  (e.g. van der Krogt et al. 2012). Here the walk itself is <b>re-invented by physics</b> for every weakness, so the
  compensations are a prediction, not an input.</p>

  <h3>How OpenSim models it</h3>
  <div class="steps">
    <div><b>1 · The body</b><span>OpenSim's 2D gait model: 9 degrees of freedom (pelvis tilt and position, hips, knees, ankles, lower back),
    <b>18 Hill-type muscles</b> with activation dynamics, elastic tendons and force-length-velocity behaviour,
    and heel and forefoot contact spheres on each foot. 62&nbsp;kg.</span></div>
    <div><b>2 · The solver</b><span><b>OpenSim Moco</b> (direct collocation, CasADi + IPOPT) searches every muscle signal and every
    joint angle over a whole stride at once (about 5,800 unknowns, 4,800 physics constraints) for the walk that costs the least
    muscle effort per metre, plus a small trunk-stability term, at 1.2&nbsp;m/s with left-right symmetry.
    Nothing is motion-captured or tracked.</span></div>
    <div><b>3 · Weakness</b><span>A muscle group's maximum force is lowered (both legs) and Moco solves the walk again from
    scratch. Whatever changes, changes because the physics demanded it.</span></div>
    <div><b>4 · Seeing it</b><span>OpenSim gives every bone pose, muscle path, activation, tendon force and ground force
    per frame; this page and the Blender film only draw those numbers.</span></div>
  </div>

  <h3>What we did to make it trustworthy</h3>
  <ol class="work">
    <li><b>Reproduced the official OpenSim example exactly</b> (objective 0.135069), so the pipeline is verified before any new run.</li>
    <li><b>Found and fixed a model bug:</b> the calf's gastrocnemius had lost its leverage at the knee (moment arm −0.14&nbsp;cm vs
    −1.61&nbsp;cm in the reference model). A wrap around the femoral condyles restores it (−2.21&nbsp;cm).</li>
    <li><b>Freed the joint limits</b> so they cannot shape the gait. That exposed an unrealistic 27° pelvis rock, so the pelvis
    alone is held to its physiological ±5°.</li>
    <li><b>Tested self-selected speed:</b> with effort alone even the healthy walker creeps at 0.45&nbsp;m/s, because the cost has no
    "price of being alive". Diagnosed and set aside until a metabolic-energy cost is added.</li>
    <li><b>Calibrated a soft-landing (trunk-stability) term</b> on the healthy walker only, over four weights, against 23 real walkers.
    The weak walkers never influenced the choice.</li>
    <li><b>Robustness:</b> each twin was re-solved from a different starting guess and on a 2× finer time grid; answers agree within 0.3&nbsp;%.</li>
    <li><b>Validated</b> the healthy walker against Fukuchi et al. 2018 (23 adults, treadmill ~1.2&nbsp;m/s)${v ? `: joint-angle error hip
    ${v.hip_angle.rmse.toFixed(1)}°, knee ${v.knee_angle.rmse.toFixed(1)}°, ankle ${v.ankle_angle.rmse.toFixed(1)}°; hip torque pattern
    r&nbsp;=&nbsp;${v.hip_moment.r.toFixed(2)}, ankle r&nbsp;=&nbsp;${v.ankle_moment.r.toFixed(2)}` : ''}.</li>
    <li><b>Built the atlas</b>: calf strength from 100&nbsp;% down to 20&nbsp;%, and other muscle groups at 40&nbsp;%.</li>
  </ol>
  ${stats ? `<div class="stats"><div><b>${stats.solves}</b><span>predictive simulations solved</span></div>
    <div><b>${stats.converged}</b><span>converged</span></div><div><b>${stats.cpu_hours}</b><span>hours of solver time</span></div>
    <div><b>18</b><span>muscles in every solve</span></div></div>` : ''}

  <h3>What the simulations found</h3>
  ${calves ? `<div class="finding">
    <b>Weak calves (40&nbsp;%) move the work up the leg.</b>
    <p>Walking costs <b>${x(calves.effort_ratio)}</b> the muscle effort of the healthy twin. The biggest take-over:
    ${topCompensators(calves).map(([mm, r]) => `<em>${SHORT[mm]} ${x(r)}</em>`).join(', ')}. Push-off disappears (the ankle never
    points the toes down), and the walker switches to quicker, shorter steps (${calves.step_s.toFixed(2)}&nbsp;s per step).
    This matches what clinical gait studies report for calf weakness: the knee and hip extensors compensate.</p></div>` : ''}
  ${dial.length > 2 ? `<div class="finding"><b>The cost of weakness is not linear.</b>
    <p>Effort against calf strength (each bar a separate simulation):</p>
    <div class="ebars">${dial.map((d) => `<div><span>${pct(d.s)}</span><i style="width:${(d.effort_ratio! / maxE) * 100}%"></i><b>${x(d.effort_ratio!)}</b></div>`).join('')}</div></div>` : ''}
  ${others.length ? `<div class="finding"><b>Every weakness has its own fingerprint.</b><ul>${others.map((e) => {
      const top = topCompensators(e, 2);
      return `<li><b>${e.label} 40&nbsp;%</b>: effort ${x(e.effort_ratio)}; most extra work in ${top.map(([mm, r]) => `${SHORT[mm]} (${x(r)})`).join(' and ')}.</li>`;
    }).join('')}</ul><p>Open <b>Atlas</b> to watch each one walk.</p></div>` : ''}

  <h3>What it does not show yet</h3>
  <p>2D (no side-to-side compensation), effort-minimising walkers at a fixed speed, weakness as lost force only. Each limit,
  with numbers, is in <b>Method &amp; limits</b>.</p>`;
}
