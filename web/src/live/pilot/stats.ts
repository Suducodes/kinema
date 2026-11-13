/**
 * Agreement statistics for method comparison (KINEMA against a reference angle):
 * Bland-Altman bias and 95 % limits of agreement, RMSE, MAE, Pearson r and ICC(2,1)
 * (two-way random effects, absolute agreement, single measurement; Shrout & Fleiss 1979).
 */
export interface Agreement {
  n: number; bias: number; sdDiff: number; loaLow: number; loaHigh: number;
  rmse: number; mae: number; r: number; icc: number;
}

const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
const sd = (a: number[]) => { const m = mean(a); return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1)); };

export function pearson(x: number[], y: number[]) {
  const mx = mean(x), my = mean(y);
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < x.length; i++) { sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) ** 2; syy += (y[i] - my) ** 2; }
  return sxy / Math.sqrt(sxx * syy);
}

/** ICC(2,1) for n targets each measured once by k = columns.length methods or raters. */
export function icc21(...columns: number[][]) {
  const k = columns.length, n = columns[0].length;
  const all = columns.flat(), G = mean(all);
  const rowMean = Array.from({ length: n }, (_, i) => mean(columns.map((c) => c[i])));
  const colMean = columns.map(mean);
  const SST = all.reduce((x, v) => x + (v - G) ** 2, 0);
  const SSR = k * rowMean.reduce((x, m) => x + (m - G) ** 2, 0);
  const SSC = n * colMean.reduce((x, m) => x + (m - G) ** 2, 0);
  const SSE = SST - SSR - SSC;
  const MSR = SSR / (n - 1), MSC = SSC / (k - 1), MSE = SSE / ((n - 1) * (k - 1));
  return (MSR - MSE) / (MSR + (k - 1) * MSE + (k * (MSC - MSE)) / n);
}

/** `test` (KINEMA) against `ref`; differences are test minus reference. */
export function agreement(ref: number[], test: number[]): Agreement {
  const d = test.map((t, i) => t - ref[i]), n = d.length;
  const bias = mean(d), s = n > 1 ? sd(d) : NaN;
  return {
    n, bias, sdDiff: s, loaLow: bias - 1.96 * s, loaHigh: bias + 1.96 * s,
    rmse: Math.sqrt(mean(d.map((v) => v * v))), mae: mean(d.map(Math.abs)),
    r: n > 2 ? pearson(ref, test) : NaN, icc: n > 2 ? icc21(test, ref) : NaN,
  };
}

/** Hand-checkable example for the self-test (values worked out by hand in the README). */
export function statsSelfTest() {
  const ref = [0, 10, 20, 30, 40], test = [1, 12, 19, 33, 42];
  const a = agreement(ref, test);
  // differences 1, 2, -1, 3, 2: bias 1.4, SD sqrt(9.2/4) = 1.5166, RMSE sqrt(19/5) = 1.9494, MAE 1.8
  // Pearson r = 1030 / sqrt(1000 x 1069.2) = 0.99611
  // ICC(2,1) from the two-way ANOVA table (G = 20.7): SSR = 2064.6, SSC = 4.9, SST = 2074.1, SSE = 4.6,
  //   MSR = 516.15, MSC = 4.9, MSE = 1.15 -> (516.15 - 1.15) / (516.15 + 1.15 + 2 (4.9 - 1.15) / 5) = 0.99268
  const expect = { bias: 1.4, sdDiff: 1.51658, rmse: 1.94936, mae: 1.8, loaLow: 1.4 - 1.96 * 1.51658, loaHigh: 1.4 + 1.96 * 1.51658, r: 0.99611, icc: 0.99268 };
  const rows = Object.entries(expect).map(([k, v]) => {
    const got = a[k as keyof Agreement] as number;
    return { k, expect: v, got, ok: Math.abs(got - v) < 1e-3 };
  });
  return { ok: rows.every((r) => r.ok), rows };
}
