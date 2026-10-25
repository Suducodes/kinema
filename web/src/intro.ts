import * as THREE from 'three';
import type { Stage } from './stage';

/**
 * Opening shot: the camera starts at the weak twin's ankle and pulls back to the full stage while
 * three short captions explain what is on screen. Any click or key skips it.
 */
export interface Key { at: number; pos: THREE.Vector3; target: THREE.Vector3 }
export interface Caption { from: number; to: number; text: string }

export function playIntro(stage: Stage, keys: Key[], captions: Caption[], onSpeed: (s: number) => void): Promise<void> {
  const total = keys[keys.length - 1].at;
  const posCurve = new THREE.CatmullRomCurve3(keys.map((k) => k.pos), false, 'centripetal');
  const tgtCurve = new THREE.CatmullRomCurve3(keys.map((k) => k.target), false, 'centripetal');
  // time -> curve parameter, piecewise linear through the keyframes, then eased
  const param = (t: number) => {
    for (let i = 1; i < keys.length; i++) {
      if (t <= keys[i].at) {
        const a = keys[i - 1], b = keys[i], f = (t - a.at) / (b.at - a.at);
        const e = f < 0.5 ? 2 * f * f : 1 - (-2 * f + 2) ** 2 / 2;
        return (i - 1 + e) / (keys.length - 1);
      }
    }
    return 1;
  };

  const box = document.createElement('div');
  box.className = 'intro-caption';
  const skip = document.createElement('button');
  skip.className = 'intro-skip';
  skip.textContent = 'Skip intro';
  document.body.append(box, skip);
  document.body.classList.add('intro');
  stage.controls.enabled = false;

  return new Promise((resolve) => {
    // wall-clock time, so captions keep their schedule even when frames are slow
    const t0 = performance.now();
    let t = 0, shown = -1, done = false;
    const finish = () => {
      if (done) return;
      done = true;
      off();
      onSpeed(1);
      posCurve.getPoint(1, stage.camera.position);
      tgtCurve.getPoint(1, stage.controls.target);
      stage.controls.enabled = true;
      document.body.classList.remove('intro');
      box.classList.remove('on');
      skip.remove();
      setTimeout(() => box.remove(), 700);
      removeEventListener('keydown', finish, true);
      removeEventListener('pointerdown', onPointer, true);
      resolve();
    };
    const onPointer = (e: PointerEvent) => { if (e.target !== skip) finish(); };
    skip.onclick = finish;
    addEventListener('keydown', finish, true);
    addEventListener('pointerdown', onPointer, true);
    const off = stage.onFrame(() => {
      t = (performance.now() - t0) / 1000;
      const u = param(Math.min(t, total));
      posCurve.getPoint(u, stage.camera.position);
      tgtCurve.getPoint(u, stage.controls.target);
      onSpeed(0.4 + 0.6 * Math.min(t / total, 1) ** 2);       // slow motion easing back to real time
      const c = captions.findIndex((x) => t >= x.from && t < x.to);
      if (c !== shown) {
        shown = c;
        box.classList.remove('on');
        if (c >= 0) setTimeout(() => { if (!done && shown === c) { box.textContent = captions[c].text; box.classList.add('on'); } }, 260);
      }
      if (t >= total + 0.2) finish();
    });
  });
}
