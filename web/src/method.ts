/** "Method & limits": what was simulated, how it was checked, and what it does not show. */
interface Manifest {
  healthy: string; weak: string; status: string;
  model: string; validation?: Record<string, { rmse: number; r: number; within_1sd_pct: number; within_2sd_pct: number }>;
  checks?: string[];
  dial?: { s: number; clip: string }[];
}

const LABEL: Record<string, string> = {
  hip_angle: 'Hip flexion angle', knee_angle: 'Knee flexion angle', ankle_angle: 'Ankle angle',
  hip_moment: 'Hip moment', knee_moment: 'Knee moment', ankle_moment: 'Ankle moment',
};

export function methodHtml(m: Manifest, ref: { n: number; source: string }) {
  const rows = m.validation ? Object.entries(m.validation).map(([k, v]) => {
    const unit = k.endsWith('angle') ? '°' : ' N·m/kg';
    return `<tr><td>${LABEL[k] ?? k}</td><td>${v.rmse.toFixed(2)}${unit}</td><td>${v.r.toFixed(2)}</td><td>${v.within_1sd_pct.toFixed(0)}%</td><td>${v.within_2sd_pct.toFixed(0)}%</td></tr>`;
  }).join('') : '';
  return `
  <h2>Method &amp; limits</h2>
  <p>${m.status}</p>
  <h3>What is simulated</h3>
  <p>Each walker is an <b>OpenSim Moco predictive simulation</b>: nothing is motion-captured. The solver invents the
  whole gait by minimising muscle effort per metre (cubed excitations) plus a small trunk-stability term (torso
  acceleration per metre, which people also damp), with left-right symmetry and the treadmill speed fixed at
  1.2&nbsp;m/s. Joint limits are wide enough not to shape the gait; only the pelvis is held to its physiological
  ±5° range, because a free 2D pelvis rocks unrealistically. The weak twin is the same body with the soleus and gastrocnemius (both legs) at 40&nbsp;%
  of their maximum isometric force. Every compensation you see emerged from the optimisation, not from animation.</p>
  <p>Model: ${m.model}</p>
  <h3>Weakness dial, atlas, X-ray</h3>
  <p><b>Dial:</b> calf strength was solved at ${m.dial?.length ? m.dial.map((d) => `${Math.round(d.s * 100)}`).join(' / ') : '100 / 40'}&nbsp;%
  (dots on the dial). Between two solved runs the walker is <b>blended</b> (same gait phase, positions and rotations
  interpolated). That is a visual interpolation, not a new simulation. <b>Atlas:</b> each card is one further predictive
  simulation with another muscle group at 40&nbsp;%, same settings, warm-started from the healthy twin; only the calf twins
  carry the full robustness checks. <b>X-ray:</b> muscle colour is tendon force as a share of the healthy muscle's maximum;
  arrows are the ground reaction force at the centre of pressure.</p>
  ${m.checks?.length ? `<h3>Checks passed</h3><ul>${m.checks.map((c) => `<li>${c}</li>`).join('')}</ul>` : ''}
  ${rows ? `<h3>Healthy twin vs real walkers</h3>
  <p>Compared with ${ref.n} young adults walking on a treadmill at ~1.2&nbsp;m/s (${ref.source}).</p>
  <table><tr><th>Signal</th><th>RMSE</th><th>r</th><th>within ±1 SD</th><th>within ±2 SD</th></tr>${rows}</table>` : ''}
  <h3>What this does not show</h3>
  <ul>
    <li><b>2D model:</b> only forward-backward (sagittal) motion. Side-to-side compensations such as a Trendelenburg gait cannot appear.</li>
    <li><b>No arms</b>, and a single trunk segment.</li>
    <li><b>Weakness, not disease:</b> lost force only. Real patients also have changed tendons, sensation, pain and control.</li>
    <li><b>Fixed speed:</b> real people with weak calves usually walk slower. A self-selected-speed comparison needs a metabolic-energy cost (with a resting cost); with effort alone, the optimiser simply creeps.</li>
    <li><b>Knee and cadence:</b> the healthy twin lands with a fairly straight knee (~6° vs ~15–20° in people) and steps faster than people do (0.43&nbsp;s vs ~0.55&nbsp;s per step). Both are known traits of effort-minimising simulations.</li>
    <li><b>Loop timing:</b> each clip is slowed 3–5&nbsp;% so a whole number of strides fills the 8&nbsp;s loop.</li>
    <li><b>Effort-minimising walkers:</b> people may not choose the least-effort gait, especially when impaired.</li>
  </ul>
  <h3>Credits</h3>
  <p>OpenSim / Moco (Stanford), 2D gait model after Falisse et al. 2019 and gait10dof18musc. Reference data:
  Fukuchi, Fukuchi &amp; Duarte 2018 (CC BY 4.0). Rendering: three.js; film in Blender Cycles.</p>`;
}
