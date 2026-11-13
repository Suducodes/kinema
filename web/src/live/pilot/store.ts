/**
 * Pilot data kept on this device only (IndexedDB: photos are too large for localStorage). Nothing is
 * sent anywhere; a refresh or crash keeps the session.
 */
export type Position = 'A' | 'B' | 'C';
export const POSITIONS: Record<Position, string> = { A: 'standing straight', B: 'half squat', C: 'deep squat' };
export const SEQUENCE: { round: 1 | 2; pos: Position }[] = [
  { round: 1, pos: 'A' }, { round: 1, pos: 'B' }, { round: 1, pos: 'C' },
  { round: 2, pos: 'A' }, { round: 2, pos: 'B' }, { round: 2, pos: 'C' },
];

export interface Participant { code: string; age: number | null; sex: 'female' | 'male' | 'prefer not to say'; heightCm: number; weightKg: number; created: string }

export interface Hold {
  id: string;                 // P01_A1 (participant, position, round)
  code: string; round: 1 | 2; pos: Position;
  kinemaMean: number; kinemaSd: number; nFrames: number; meanConf: number;
  windowS: number; band: number; manual: boolean;
  captured: string;           // ISO time
  photoFrameT: number;        // time of the saved video frame inside the window (s, app clock)
  photoW: number; photoH: number;
  previewMirrored: boolean;   // the on-screen preview; saved photos are always unmirrored
  blurred: boolean;
  external: number | null;    // optional cross-check angle (e.g. Kinovea)
  notes: string;
  retake: boolean;            // flagged by a rater: stickers not visible
}

export interface Measure { id: string; holdId: string; rater: string; pts: [number, number][]; interior: number; flexion: number; ts: string }

export interface ValgusRep {
  id: string; code: string; rep: number; coachPeakValgus: number; peakValgusR: number; peakValgusL: number;
  depth: number; downS: number; upS: number; ts: string;
}

export interface PhysicsRecord { id: string; csv: string; meta: Record<string, unknown> }

const STORES = ['participants', 'holds', 'photos', 'physics', 'measures', 'valgus', 'kv'] as const;
type StoreName = (typeof STORES)[number];

export class PilotStore {
  private db: Promise<IDBDatabase>;
  constructor(readonly name = 'kinema-pilot') {
    this.db = new Promise((ok, fail) => {
      const req = indexedDB.open(name, 1);
      req.onupgradeneeded = () => { for (const s of STORES) if (!req.result.objectStoreNames.contains(s)) req.result.createObjectStore(s); };
      req.onsuccess = () => ok(req.result);
      req.onerror = () => fail(req.error);
    });
  }

  private async tx<T>(store: StoreName, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const db = await this.db;
    return new Promise((ok, fail) => {
      const t = db.transaction(store, mode), r = fn(t.objectStore(store));
      t.oncomplete = () => ok(r.result); t.onerror = () => fail(t.error); t.onabort = () => fail(t.error);
    });
  }

  put<T>(store: StoreName, key: string, value: T) { return this.tx(store, 'readwrite', (s) => s.put(value, key)); }
  get<T>(store: StoreName, key: string) { return this.tx<T | undefined>(store, 'readonly', (s) => s.get(key) as IDBRequest<T | undefined>); }
  del(store: StoreName, key: string) { return this.tx(store, 'readwrite', (s) => s.delete(key)); }
  all<T>(store: StoreName) { return this.tx<T[]>(store, 'readonly', (s) => s.getAll() as IDBRequest<T[]>); }
  keys(store: StoreName) { return this.tx<IDBValidKey[]>(store, 'readonly', (s) => s.getAllKeys()); }

  async clearAll() { for (const s of STORES) await this.tx(s, 'readwrite', (st) => st.clear()); }
  async destroy() {
    (await this.db).close();
    await new Promise<void>((ok) => { const r = indexedDB.deleteDatabase(this.name); r.onsuccess = r.onerror = r.onblocked = () => ok(); });
  }
}
