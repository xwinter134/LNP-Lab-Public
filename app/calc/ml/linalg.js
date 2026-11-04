// Small dense linear algebra for the ML module. Arrays of arrays, no dependencies.
// Sized for the lab's reality: n < ~300 runs, so O(n^3) Cholesky is instant and clarity beats cleverness.

export const zeros = (n, m) => (m == null ? new Float64Array(n) : Array.from({ length: n }, () => new Float64Array(m)));
export const eye = (n, v = 1) => { const A = zeros(n, n); for (let i = 0; i < n; i++) A[i][i] = v; return A; };
export const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };

/** Matrix-vector product A x. */
export function matVec(A, x) {
  const out = new Float64Array(A.length);
  for (let i = 0; i < A.length; i++) out[i] = dot(A[i], x);
  return out;
}

/**
 * Cholesky factorisation A = L Lᵀ for a symmetric positive-definite A, adding jitter to the diagonal
 * if the factorisation fails. Kernel matrices are PSD in theory but near-singular in practice when two
 * runs sit close together, which is exactly what happens with replicates.
 * @returns {{L: number[][], jitter: number}|null} null if even the largest jitter fails.
 */
export function cholesky(A, { jitters = [0, 1e-10, 1e-8, 1e-7, 1e-6, 1e-4], absolute = true } = {}) {
  const n = A.length;
  // The kernel diagonal is about 1 + σ² because the signal variance is fixed and the outputs are standardised,
  // so an absolute jitter ladder is the right scale. Needing more than 1e-6 means two runs sit on top of each
  // other, which is a duplicate to merge rather than a number to paper over.
  let scale = 1;
  if (!absolute) { scale = 0; for (let i = 0; i < n; i++) scale += A[i][i]; scale = Math.max(scale / n, 1e-12); }
  for (const j of jitters) {
    const L = zeros(n, n);
    let ok = true;
    for (let i = 0; i < n && ok; i++) {
      const Li = L[i];
      for (let k = 0; k <= i; k++) {
        const Lk = L[k];
        let s = A[i][k] + (i === k ? j * scale : 0);
        for (let m = 0; m < k; m++) s -= Li[m] * Lk[m];
        if (i === k) {
          if (!(s > 0) || !Number.isFinite(s)) { ok = false; break; }
          L[i][i] = Math.sqrt(s);
        } else L[i][k] = s / L[k][k];
      }
    }
    if (ok) return { L, jitter: j * scale };
  }
  return null;
}

/** Solve L z = b for lower-triangular L. */
export function forwardSub(L, b) {
  const n = L.length, z = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = b[i];
    for (let k = 0; k < i; k++) s -= L[i][k] * z[k];
    z[i] = s / L[i][i];
  }
  return z;
}
/** Solve Lᵀ x = z for lower-triangular L. */
export function backSub(L, z) {
  const n = L.length, x = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let s = z[i];
    for (let k = i + 1; k < n; k++) s -= L[k][i] * x[k];
    x[i] = s / L[i][i];
  }
  return x;
}
/** Solve A x = b given the Cholesky factor of A. */
export const cholSolve = (L, b) => backSub(L, forwardSub(L, b));
/** log|A| from its Cholesky factor. */
export function cholLogDet(L) { let s = 0; for (let i = 0; i < L.length; i++) s += Math.log(L[i][i]); return 2 * s; }
/** A⁻¹ from its Cholesky factor (needed for the marginal-likelihood gradient). */
export function cholInverse(L) {
  const n = L.length, inv = zeros(n, n);
  for (let j = 0; j < n; j++) {
    const e = new Float64Array(n); e[j] = 1;
    const col = cholSolve(L, e);
    for (let i = 0; i < n; i++) inv[i][j] = col[i];
  }
  return inv;
}

/**
 * A⁻¹ from its Cholesky factor by way of L⁻¹: invert the triangle once (n³/6 multiply-adds, each column a
 * forward substitution that starts at its own diagonal), then A⁻¹ = L⁻ᵀ L⁻¹, of which only one half is formed
 * (another n³/6). cholInverse above does n full solves against a fresh unit vector each, about 2n³ and n
 * allocations, which is what the marginal-likelihood gradient paid on every optimiser step (spec 7.8). Same
 * numbers to rounding; tests/mlphase4.test.mjs holds the two against each other.
 */
export function cholInverseFast(L) {
  const n = L.length;
  // C[j] is column j of L⁻¹, stored as a row so every inner loop below runs along contiguous memory.
  const C = zeros(n, n);
  for (let j = 0; j < n; j++) {
    const c = C[j];
    c[j] = 1 / L[j][j];
    for (let i = j + 1; i < n; i++) {
      const Lrow = L[i];
      let s = 0;
      for (let k = j; k < i; k++) s -= Lrow[k] * c[k];
      c[i] = s / Lrow[i];
    }
  }
  // (L⁻ᵀ L⁻¹)_ij = Σ_k L⁻¹_ki L⁻¹_kj = C[i]·C[j], over k ≥ max(i, j) where both are non-zero.
  const inv = zeros(n, n);
  for (let i = 0; i < n; i++) {
    const ci = C[i];
    for (let j = 0; j <= i; j++) {
      const cj = C[j];
      let s = 0;
      for (let k = i; k < n; k++) s += ci[k] * cj[k];
      inv[i][j] = s; inv[j][i] = s;
    }
  }
  return inv;
}

/** Solve the least-squares problem X b = y with ridge regularisation λ (normal equations + Cholesky). */
export function ridgeSolve(X, y, lambda = 1e-8) {
  const n = X.length, p = X[0].length;
  const XtX = zeros(p, p), Xty = new Float64Array(p);
  for (let i = 0; i < n; i++) for (let a = 0; a < p; a++) {
    Xty[a] += X[i][a] * y[i];
    for (let b = 0; b <= a; b++) XtX[a][b] += X[i][a] * X[i][b];
  }
  for (let a = 0; a < p; a++) { for (let b = a + 1; b < p; b++) XtX[a][b] = XtX[b][a]; XtX[a][a] += lambda; }
  const ch = cholesky(XtX);
  return ch ? Array.from(cholSolve(ch.L, Xty)) : null;
}

/* ---------------- normal distribution ---------------- */
export const normPdf = (z) => Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI);
/** Standard normal CDF via erf (Abramowitz & Stegun 7.1.26, |error| < 1.5e-7). */
export function normCdf(z) {
  const s = z < 0 ? -1 : 1, x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return 0.5 * (1 + s * y);
}
/** Inverse standard normal CDF (Acklam's rational approximation, |error| < 1.15e-9). */
export function normInv(p) {
  if (!(p > 0 && p < 1)) return p <= 0 ? -Infinity : Infinity;
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];
  const pl = 0.02425;
  let q, r;
  if (p < pl) { q = Math.sqrt(-2 * Math.log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  if (p > 1 - pl) { q = Math.sqrt(-2 * Math.log(1 - p)); return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  q = p - 0.5; r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

/** Deterministic PRNG so every suggestion run is reproducible from its seed. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
/** Standard normal sample from a uniform generator (Box-Muller). */
export function randn(rnd) { let u = 0; while (u === 0) u = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd()); }
