/** Compensation atlas: one card per weakened muscle group, each a separate predictive simulation. */
export interface AtlasEntry {
  id: string; label: string; muscles: string; clip: string; strength: number;
  weakened: string[];                     // right-leg muscle names that were weakened
  effort_ratio: number; step_s: number; converged: boolean; robust?: boolean;
  fingerprint: Record<string, number>;    // mean activation ratio vs healthy, right leg
}

export const MUSCLE_ORDER = ['glut_max_r', 'iliopsoas_r', 'rect_fem_r', 'hamstrings_r', 'bifemsh_r', 'vasti_r', 'gastroc_r', 'soleus_r', 'tib_ant_r'];
export const SHORT: Record<string, string> = {
  glut_max_r: 'Glut max', iliopsoas_r: 'Iliopsoas', rect_fem_r: 'Rect fem', hamstrings_r: 'Hamstrings',
  bifemsh_r: 'Bi fem SH', vasti_r: 'Vasti', gastroc_r: 'Gastroc', soleus_r: 'Soleus', tib_ant_r: 'Tib ant',
};

const LIM = Math.log2(6);   // bars span x1/6 .. x6

function bars(e: AtlasEntry) {
  return MUSCLE_ORDER.map((m) => {
    const r = e.fingerprint[m] ?? 1, v = Math.max(-LIM, Math.min(LIM, Math.log2(r))) / LIM;
    const weak = e.weakened.includes(m);
    const bar = `<span class="bar ${v >= 0 ? 'up' : 'down'}" style="${v >= 0 ? 'left:50%' : `right:50%`};width:${Math.abs(v) * 50}%"></span>`;
    return `<div class="fp-row${weak ? ' weak' : ''}"><span class="n">${SHORT[m]}</span><span class="track">${weak ? '' : bar}<i></i></span><b>${weak ? 'weakened' : `×${r < 10 ? r.toFixed(1) : r.toFixed(0)}`}</b></div>`;
  }).join('');
}

export function renderAtlas(root: HTMLElement, entries: AtlasEntry[], current: string, onPick: (e: AtlasEntry) => void) {
  root.innerHTML = `
    <div class="atlas-head">
      <h2>Compensation atlas</h2>
      <p>Each card is its own predictive simulation: the same body at the same 1.2&nbsp;m/s, with one muscle group
      at ${Math.round((entries[0]?.strength ?? 0.4) * 100)}&nbsp;% strength. Bars show how much harder (red) or easier (blue) every other
      right-leg muscle works than in the healthy walker. Nothing is prescribed: each pattern is what the optimiser found.</p>
    </div>
    <div class="atlas-grid">${entries.map((e) => `
      <button class="card${e.id === current ? ' on' : ''}" data-id="${e.id}" ${e.converged ? '' : 'disabled'}>
        <header><b>${e.label}</b><em>${Math.round(e.strength * 100)}%</em></header>
        <small>${e.muscles}</small>
        <div class="fp">${bars(e)}</div>
        <footer><span>effort <b>×${e.effort_ratio.toFixed(2)}</b></span><span>step <b>${e.step_s.toFixed(2)} s</b></span>
        ${e.robust ? '<span class="tag" title="Alternate initial guess and 2x mesh agree within 0.3%">robustness-checked</span>' : ''}</footer>
        <span class="go">${e.id === current ? 'Walking now' : 'Walk it →'}</span>
      </button>`).join('')}
    </div>
    <p class="atlas-note">Effort is the solver's cost per metre relative to the healthy walker. Cards without the robustness tag
    are single solves; the calf twins were also re-solved from another initial guess and on a 2× finer time grid.</p>`;
  root.querySelectorAll<HTMLButtonElement>('.card').forEach((b) => b.addEventListener('click', () => {
    const e = entries.find((x) => x.id === b.dataset.id);
    if (e) onPick(e);
  }));
}
