import { Body } from '../body';
import { Physics } from '../physics';
import { Demo, PROTOCOL_HOLD_S, PROTOCOL_LEVELS } from '../demo';
import { LandmarkSmoother } from '../filters';
import { PilotRun, OVERLAY_COLOURS, type FrameSource, type Img } from './run';
import { PilotStore, type Participant, type PhysicsRecord } from './store';
import { CSV_COLUMNS, buildRows, loadAll, resultsCsv } from './results';
import { angleSelfTest, flexionFromInterior, interiorDeg } from './angle';
import { statsSelfTest } from './stats';
import type { PilotHost } from './index';

/**
 * Pilot-mode self-test: the synthetic performer goes through the protocol (stand, half squat, deep
 * squat, twice) in front of a synthetic "camera" (a canvas drawing of the performer with green
 * stickers). Checks that all six holds are auto-detected, each has a clean photo and an overlay
 * screenshot, the clean photo contains no overlay colours, and the CSV has the expected columns and
 * six rows. Runs in a separate database, so real pilot data is untouched.
 */
export async function pilotSelfTest(host: PilotHost) {
  const store = new PilotStore('kinema-pilot-selftest');
  await store.clearAll();
  const meta = host.twin.meta, body = new Body(meta), phys = new Physics(meta), demo = new Demo(meta, 'protocol'), sm = new LandmarkSmoother();
  phys.setMass(70);
  for (let t = 0; t < 0.3; t += 1 / 30) body.addCalibrationSample(demo.frame(t).frame);
  body.finishCalibration(1.75);
  const W = 640, H = 480, cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const g = cv.getContext('2d')!;
  const participant: Participant = { code: 'T01', age: 30, sex: 'prefer not to say', heightCm: 175, weightKg: 70, created: new Date().toISOString() };
  await store.put('participants', participant.code, participant);
  const source: FrameSource = { mirrored: false, grab: () => createImageBitmap(cv) };
  const st = host.stage;
  const run = new PilotRun({ store, participant, meta, hashes: host.twin.hashes, band: 2, duration: 3, blur: true, source,
    inset: () => { st.renderer.render(st.scene, st.override ?? st.camera); return st.renderer.domElement; } });
  const auto: number[] = [];
  const total = PROTOCOL_HOLD_S * PROTOCOL_LEVELS.length + 0.5;
  for (let t = 0; t < total; t += 1 / 30) {
    const f = sm.apply(demo.frame(t).frame);
    body.update(f); phys.update(body, t);
    // a side-on camera on the performer's right (as the protocol asks): image x = forward, y = down
    // (normalised like MediaPipe: x by the width, y by the height, so the same metres -> pixels both ways)
    const image: Img = f.world.map((p) => ({ x: 0.5 + (p.z * 0.25 * H) / W, y: 0.42 - p.y * 0.25, v: 0.95 }));
    drawPerformer(g, W, H, image);
    const before = run.holds.filter(Boolean).length;
    run.onFrame({ t, image, body, phys });
    if (run.pending) { await run.pending; if (run.holds.filter(Boolean).length > before) auto.push(t); }
    await new Promise((r) => setTimeout(r, 0));   // let the background frame grabs land, as they would between camera frames
  }
  if (run.pending) await run.pending;

  // ---- checks
  const holds = run.holds;
  const photos = await Promise.all(holds.map(async (h) => ({
    clean: h ? await store.get<Blob>('photos', `${h.id}_clean`) : undefined,
    overlay: h ? await store.get<Blob>('photos', `${h.id}_overlay`) : undefined,
  })));
  const overlayPixels = async (b?: Blob) => (b ? countOverlay(await createImageBitmap(b)) : -1);
  const pixelRows = await Promise.all(photos.map(async (p) => ({ clean: await overlayPixels(p.clean), overlay: await overlayPixels(p.overlay) })));
  // end to end: find the three green stickers in each clean photo and measure them as a rater would
  const reference = await Promise.all(photos.map(async (p) => (p.clean ? stickerFlexion(await createImageBitmap(p.clean)) : NaN)));
  const d = await loadAll(store), csv = resultsCsv(buildRows(d)), lines = csv.split('\n');
  const phys6 = await Promise.all(holds.map((h) => (h ? store.get<PhysicsRecord>('physics', h.id) : Promise.resolve(undefined))));
  const report = {
    holdsDetected: holds.filter(Boolean).length,
    autoCaptured: holds.filter((h) => h && !h.manual).length,
    holds: holds.map((h, i) => h && { id: h.id, kinemaMean: +h.kinemaMean.toFixed(2), kinemaSd: +h.kinemaSd.toFixed(2), nFrames: h.nFrames,
      truthKnee: +(104 * PROTOCOL_LEVELS[i]).toFixed(1), photoReference: +reference[i].toFixed(2), photo: `${h.photoW}x${h.photoH}`, cleanOverlayPixels: pixelRows[i].clean, overlayOverlayPixels: pixelRows[i].overlay,
      physicsRows: phys6[i] ? phys6[i]!.csv.split('\n').length - 1 : 0 }),
    csvColumnsOk: lines[0] === CSV_COLUMNS.join(','), csvRows: lines.length - 1,
    physicsColumns: phys6[0] ? phys6[0]!.csv.split('\n')[0].split(',').length : 0,
    angleTool: angleSelfTest(), stats: statsSelfTest(),
    sampleCsv: lines.slice(0, 3).join('\n'),
  };
  const ok = report.holdsDetected === 6 && report.autoCaptured === 6 && report.csvColumnsOk && report.csvRows === 6
    && report.holds.every((h) => h && h.cleanOverlayPixels === 0 && h.overlayOverlayPixels > 50 && h.physicsRows > 60)
    && report.angleTool.ok && report.stats.ok;
  run.dispose();
  return { ok, ...report, physicsSample: phys6[1] ? { meta: phys6[1].meta, csv: phys6[1].csv } : null, cleanup: () => store.destroy() };
}

/** The synthetic camera frame: a grey figure on a dark wall, green stickers on the right hip, knee and ankle. */
function drawPerformer(g: CanvasRenderingContext2D, W: number, H: number, img: Img) {
  const grad = g.createLinearGradient(0, 0, 0, H); grad.addColorStop(0, '#2c3034'); grad.addColorStop(1, '#3a3d40');
  g.fillStyle = grad; g.fillRect(0, 0, W, H);
  g.fillStyle = '#4a4d50'; g.fillRect(0, H * 0.66, W, H * 0.34);
  const P = (i: number): [number, number] => [img[i].x * W, img[i].y * H];
  g.lineCap = 'round'; g.strokeStyle = '#9a9a9a';
  for (const [a, b, w] of [[11, 12, 22], [11, 23, 26], [12, 24, 26], [23, 24, 26], [23, 25, 20], [25, 27, 16], [24, 26, 20], [26, 28, 16],
    [11, 13, 13], [13, 15, 11], [12, 14, 13], [14, 16, 11], [27, 31, 10], [28, 32, 10]]) {
    g.lineWidth = w; g.beginPath(); g.moveTo(...P(a)); g.lineTo(...P(b)); g.stroke();
  }
  g.fillStyle = '#a5a5a5'; g.beginPath(); g.arc(...P(0), 20, 0, Math.PI * 2); g.fill();
  g.fillStyle = 'rgb(60,200,90)';
  for (const i of [24, 26, 28]) { g.beginPath(); g.arc(...P(i), 4.5, 0, Math.PI * 2); g.fill(); }
}

/** Knee flexion from the stickers in a clean photo: centres of the three green blobs, hip highest. */
function stickerFlexion(bmp: ImageBitmap) {
  const c = new OffscreenCanvas(bmp.width, bmp.height), g = c.getContext('2d')!;
  g.drawImage(bmp, 0, 0);
  const d = g.getImageData(0, 0, bmp.width, bmp.height).data, blobs: { x: number; y: number; n: number }[] = [];
  for (let y = 0; y < bmp.height; y++) for (let x = 0; x < bmp.width; x++) {
    const i = (y * bmp.width + x) * 4;
    if (!(d[i] < 120 && d[i + 1] > 150 && d[i + 2] < 150 && d[i + 1] - d[i] > 60)) continue;
    const b = blobs.find((q) => Math.hypot(q.x / q.n - x, q.y / q.n - y) < 12);
    if (b) { b.x += x; b.y += y; b.n++; } else blobs.push({ x, y, n: 1 });
  }
  const pts = blobs.filter((b) => b.n >= 6).map((b) => [b.x / b.n, b.y / b.n] as [number, number]).sort((a, b) => a[1] - b[1]);
  if (pts.length !== 3) return NaN;
  return flexionFromInterior(interiorDeg(pts[0], pts[1], pts[2]));
}

/** Pixels within a small colour distance of the overlay palette. */
function countOverlay(bmp: ImageBitmap) {
  const c = new OffscreenCanvas(bmp.width, bmp.height), g = c.getContext('2d')!;
  g.drawImage(bmp, 0, 0);
  const d = g.getImageData(0, 0, bmp.width, bmp.height).data;
  let n = 0;
  for (let i = 0; i < d.length; i += 4) for (const [r, gg, b] of OVERLAY_COLOURS) if (Math.abs(d[i] - r) < 30 && Math.abs(d[i + 1] - gg) < 30 && Math.abs(d[i + 2] - b) < 30) { n++; break; }
  return n;
}
