import { agreement, icc21, type Agreement } from './stats';
import type { Hold, Measure, Participant, PhysicsRecord, PilotStore, Position, ValgusRep } from './store';
import { makeZip, type ZipEntry } from './zip';

/** Results across volunteers, the agreement statistics, and every export file. */
export const CSV_COLUMNS = ['participant_code', 'age', 'sex', 'height_cm', 'weight_kg', 'round', 'position', 'reference_deg_r1', 'reference_deg_r2',
  'external_deg', 'kinema_mean_deg', 'kinema_sd_deg', 'n_frames', 'mean_confidence', 'diff_deg', 'notes', 'timestamp_iso'];
export const CONVENTION = 'Knee FLEXION in degrees: straight leg = 0, bending positive. Reference = 180 - interior angle at the knee sticker ' +
  '(hip-knee-ankle) measured on the clean photo. KINEMA = mean right-knee flexion over the auto-detected still window. diff = KINEMA - reference (rater R1).';

export interface Row { hold: Hold; p: Participant | undefined; r1: Measure | undefined; r2: Measure | undefined; ref: number | null; diff: number | null }
export interface Summary { overall: Agreement | null; byPos: Record<Position, Agreement | null>; inter: { n: number; icc: number; mad: number } | null; pairs: number }

export async function loadAll(store: PilotStore) {
  const [participants, holds, measures, valgus] = await Promise.all([store.all<Participant>('participants'), store.all<Hold>('holds'),
    store.all<Measure>('measures'), store.all<ValgusRep>('valgus')]);
  holds.sort((a, b) => a.code.localeCompare(b.code) || a.round - b.round || a.pos.localeCompare(b.pos));
  return { participants, holds, measures, valgus };
}

export function buildRows(d: Awaited<ReturnType<typeof loadAll>>, refRater = 'R1', secondRater = 'R2'): Row[] {
  return d.holds.map((hold) => {
    const r1 = d.measures.find((m) => m.holdId === hold.id && m.rater === refRater);
    const r2 = d.measures.find((m) => m.holdId === hold.id && m.rater === secondRater);
    const ref = r1 ? r1.flexion : null;
    return { hold, p: d.participants.find((p) => p.code === hold.code), r1, r2, ref, diff: ref === null ? null : hold.kinemaMean - ref };
  });
}

export function summarise(rows: Row[], minPairs = 10): Summary {
  const paired = rows.filter((r) => r.ref !== null && !r.hold.retake);
  const ag = (rs: Row[], min: number) => (rs.length >= min ? agreement(rs.map((r) => r.ref!), rs.map((r) => r.hold.kinemaMean)) : null);
  const both = rows.filter((r) => r.r1 && r.r2);
  return {
    pairs: paired.length,
    overall: ag(paired, minPairs),
    byPos: { A: ag(paired.filter((r) => r.hold.pos === 'A'), 3), B: ag(paired.filter((r) => r.hold.pos === 'B'), 3), C: ag(paired.filter((r) => r.hold.pos === 'C'), 3) },
    inter: both.length >= minPairs ? {
      n: both.length, icc: icc21(both.map((r) => r.r1!.flexion), both.map((r) => r.r2!.flexion)),
      mad: both.reduce((a, r) => a + Math.abs(r.r1!.flexion - r.r2!.flexion), 0) / both.length,
    } : null,
  };
}

const csvCell = (v: unknown) => {
  if (v === null || v === undefined || (typeof v === 'number' && !Number.isFinite(v))) return '';
  const s = typeof v === 'number' ? (Number.isInteger(v) ? String(v) : v.toFixed(3)) : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function resultsCsv(rows: Row[]) {
  const lines = rows.map((r) => [r.hold.code, r.p?.age, r.p?.sex, r.p?.heightCm, r.p?.weightKg, r.hold.round, r.hold.pos, r.r1?.flexion, r.r2?.flexion,
    r.hold.external, r.hold.kinemaMean, r.hold.kinemaSd, r.hold.nFrames, r.hold.meanConf, r.diff, r.hold.notes, r.hold.captured].map(csvCell).join(','));
  return [CSV_COLUMNS.join(','), ...lines].join('\n');
}

export function valgusCsv(reps: ValgusRep[], participants: Participant[]) {
  const cols = ['participant_code', 'age', 'sex', 'height_cm', 'weight_kg', 'rep', 'coach_peak_valgus_deg', 'peak_valgus_right_deg', 'peak_valgus_left_deg',
    'depth_deg', 'down_s', 'up_s', 'timestamp_iso'];
  const lines = reps.map((r) => { const p = participants.find((x) => x.code === r.code);
    return [r.code, p?.age, p?.sex, p?.heightCm, p?.weightKg, r.rep, r.coachPeakValgus, r.peakValgusR, r.peakValgusL, r.depth, r.downS, r.upS, r.ts].map(csvCell).join(','); });
  return [cols.join(','), ...lines].join('\n');
}

export function metadata(hashes: { json: string; glb: string }) {
  return {
    app: 'KINEMA Motion Twin, pilot measurement mode', version: __APP_VERSION__, commit: __APP_COMMIT__,
    model_files: { twin_json_sha256_16: hashes.json, twin_glb_sha256_16: hashes.glb },
    exported: new Date().toISOString(), angle_convention: CONVENTION,
    statistics: 'Bland-Altman bias and 95% limits of agreement (bias +/- 1.96 SD of differences), RMSE, MAE, Pearson r, ICC(2,1) (two-way random, absolute agreement, single measures; Shrout & Fleiss 1979).',
    privacy: 'Data and photos were stored only on the capturing device. Participants are identified by code only.',
    note: 'Model estimate for research use; not a diagnostic measurement.',
  };
}

export async function exportJson(store: PilotStore, hashes: { json: string; glb: string }) {
  const d = await loadAll(store);
  return JSON.stringify({ metadata: metadata(hashes), participants: d.participants, holds: d.holds,
    measures: d.measures.map((m) => ({ ...m, points_px: { hip: m.pts[0], knee: m.pts[1], ankle: m.pts[2] } })), valgus_reps: d.valgus }, null, 1);
}

export async function photosZip(store: PilotStore, hashes: { json: string; glb: string }) {
  const d = await loadAll(store), entries: ZipEntry[] = [];
  for (const h of d.holds) {
    const tag = `${h.code}_${h.pos}${h.round}`;
    const c = await store.get<Blob>('photos', `${h.id}_clean`), o = await store.get<Blob>('photos', `${h.id}_overlay`);
    if (c) entries.push({ name: `${tag}_clean.jpg`, data: c });
    if (o) entries.push({ name: `${tag}_overlay.png`, data: o });
  }
  entries.push({ name: 'metadata.json', data: JSON.stringify({ ...metadata(hashes), photos: 'clean = raw camera frame, unmirrored, no overlay (faces pixelated if the blur option was on); overlay = the same frame with KINEMA\'s tracked skeleton and angle' }, null, 1) });
  return makeZip(entries);
}

export async function physicsZip(store: PilotStore, hashes: { json: string; glb: string }) {
  const recs = await store.all<PhysicsRecord>('physics'), entries: ZipEntry[] = [];
  for (const r of recs) {
    entries.push({ name: `${r.id}_physics.csv`, data: r.csv });
    entries.push({ name: `${r.id}_physics.json`, data: JSON.stringify(r.meta, null, 1) });
  }
  entries.push({ name: 'metadata.json', data: JSON.stringify(metadata(hashes), null, 1) });
  return makeZip(entries);
}

export function download(blob: Blob, name: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
