import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

/** The full-body twin exported by live/export_twin.py (Lenhart 2015 OpenSim model). */
export type V3 = [number, number, number];
export const COORDS = ['hip_flex', 'hip_add', 'hip_rot', 'knee_flex', 'ankle_flex'] as const;
export type Coord = (typeof COORDS)[number];

export interface SegParams { mass: number; com: V3; I: number[][] }
export interface MuscleParams { fmax: number; lopt: number; lts: number; penn: number; L0: number; pretty: string }

export interface TwinMeta {
  source: string;
  model_mass: number;
  refs: {
    pelvis: { hipR: V3; hipL: V3; lumbar: V3 };
    torso: { shoulderR: V3; shoulderL: V3; neck: V3 };
    head: { center: V3; top: V3 };
    femur: { knee: V3 }; tibia: { ankle: V3 }; foot: { ankle: V3; heel: V3; toe: V3 };
    humerus: { elbow: V3 }; forearm: { wrist: V3 }; hand: { tip: V3 };
  };
  segments: Record<string, SegParams>;
  axes: { hip: V3[]; knee: V3; ankle: V3 };
  patella: { knee: number[]; pose: number[][] };
  muscles: {
    names: string[];
    params: Record<string, MuscleParams>;
    routes: Record<string, [string, number, number, number][]>;
    groups: Record<string, string[]>;
  };
  arms: { grids: Record<Coord, number[]>; r: Record<string, Record<Coord, number[]>> };
}

export interface Twin { meta: TwinMeta; geometry: Map<string, THREE.BufferGeometry> }

export async function loadTwin(base: string): Promise<Twin> {
  const [meta, gltf] = await Promise.all([
    fetch(`${base}live/twin.json`).then((r) => r.json() as Promise<TwinMeta>),
    new GLTFLoader().loadAsync(`${base}live/twin.glb`),
  ]);
  const geometry = new Map<string, THREE.BufferGeometry>();
  gltf.scene.traverse((o) => { if ((o as THREE.Mesh).isMesh) geometry.set(o.name, (o as THREE.Mesh).geometry); });
  return { meta, geometry };
}

/** Linear interpolation in a table sampled on an ascending grid (clamped at the ends). */
export function interp(grid: number[], vals: number[], x: number) {
  const n = grid.length;
  if (x <= grid[0]) return vals[0];
  if (x >= grid[n - 1]) return vals[n - 1];
  let i = Math.floor(((x - grid[0]) / (grid[n - 1] - grid[0])) * (n - 1));
  i = Math.min(Math.max(i, 0), n - 2);
  while (i > 0 && grid[i] > x) i--;
  while (i < n - 2 && grid[i + 1] < x) i++;
  const w = (x - grid[i]) / (grid[i + 1] - grid[i]);
  return vals[i] * (1 - w) + vals[i + 1] * w;
}
