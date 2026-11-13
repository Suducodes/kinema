/**
 * Reference knee angle from three clicked points on a photo (hip, knee and ankle stickers).
 * The interior angle at the knee is the angle between knee->hip and knee->ankle; knee FLEXION
 * (straight leg = 0) = 180 - interior.
 */
export type Pt = [number, number];

export function interiorDeg(hip: Pt, knee: Pt, ankle: Pt) {
  const ax = hip[0] - knee[0], ay = hip[1] - knee[1], bx = ankle[0] - knee[0], by = ankle[1] - knee[1];
  const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
  if (!la || !lb) return NaN;
  return (Math.acos(Math.min(Math.max((ax * bx + ay * by) / (la * lb), -1), 1)) * 180) / Math.PI;
}

export const flexionFromInterior = (interior: number) => 180 - interior;

/** Synthetic check: points at a known interior angle (thigh straight up from the knee, shank rotated). */
export function angleSelfTest() {
  const rows = [90, 135, 180].map((interior) => {
    const k: Pt = [400, 300], L = 180, a = (interior * Math.PI) / 180;
    const hip: Pt = [k[0], k[1] - L];                                   // straight up in image coordinates
    const ankle: Pt = [k[0] + L * Math.sin(a), k[1] - L * Math.cos(a)];  // rotated from the thigh by the interior angle
    const got = interiorDeg(hip, k, ankle), flex = flexionFromInterior(got);
    return { interior, got, flexion: flex, expectFlexion: 180 - interior, ok: Math.abs(got - interior) < 1e-6 && Math.abs(flex - (180 - interior)) < 1e-6 };
  });
  return { ok: rows.every((r) => r.ok), rows };
}
