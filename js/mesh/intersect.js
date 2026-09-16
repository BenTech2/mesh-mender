/**
 * Triangle-triangle intersection (Möller's interval-overlap test) and the
 * self-intersection search built on it.
 *
 * Self-intersections are the defect 3D Builder was quietest about and slicers
 * are loudest about: the mesh can be perfectly watertight and still describe an
 * object whose inside is ambiguous where two walls pass through each other.
 */
import { TriangleBVH } from './bvh.js';
import { Mesh } from './core.js';
import { fillHoles } from './holes.js';
import { buildWeldMap } from './cleanup.js';
import { buildEdgeTable, faceComponents } from './topology.js';

const EPS = 1e-12;

function sub(a, b, out) { out[0] = a[0] - b[0]; out[1] = a[1] - b[1]; out[2] = a[2] - b[2]; return out; }
function cross(a, b, out) {
  out[0] = a[1] * b[2] - a[2] * b[1];
  out[1] = a[2] * b[0] - a[0] * b[2];
  out[2] = a[0] * b[1] - a[1] * b[0];
  return out;
}
function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }

/** 2D orientation sign, used by the coplanar path. */
function orient2d(ax, ay, bx, by, cx, cy) {
  return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
}

function segmentsCross(ax, ay, bx, by, cx, cy, dx, dy) {
  const d1 = orient2d(ax, ay, bx, by, cx, cy);
  const d2 = orient2d(ax, ay, bx, by, dx, dy);
  const d3 = orient2d(cx, cy, dx, dy, ax, ay);
  const d4 = orient2d(cx, cy, dx, dy, bx, by);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
         ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

function pointInTri2d(px, py, ax, ay, bx, by, cx, cy) {
  const d1 = orient2d(ax, ay, bx, by, px, py);
  const d2 = orient2d(bx, by, cx, cy, px, py);
  const d3 = orient2d(cx, cy, ax, ay, px, py);
  const neg = (d1 < 0) || (d2 < 0) || (d3 < 0);
  const pos = (d1 > 0) || (d2 > 0) || (d3 > 0);
  return !(neg && pos);
}

function coplanarOverlap(N, p0, p1, p2, q0, q1, q2) {
  // drop the axis the plane faces most strongly
  const ax = Math.abs(N[0]), ay = Math.abs(N[1]), az = Math.abs(N[2]);
  let i0, i1;
  if (ax > ay) { if (ax > az) { i0 = 1; i1 = 2; } else { i0 = 0; i1 = 1; } }
  else { if (az > ay) { i0 = 0; i1 = 1; } else { i0 = 0; i1 = 2; } }

  const P = [[p0[i0], p0[i1]], [p1[i0], p1[i1]], [p2[i0], p2[i1]]];
  const Q = [[q0[i0], q0[i1]], [q1[i0], q1[i1]], [q2[i0], q2[i1]]];
  for (let i = 0; i < 3; i++) {
    const a = P[i], b = P[(i + 1) % 3];
    for (let j = 0; j < 3; j++) {
      const c = Q[j], d = Q[(j + 1) % 3];
      if (segmentsCross(a[0], a[1], b[0], b[1], c[0], c[1], d[0], d[1])) return true;
    }
  }
  // fully contained either way
  if (pointInTri2d(P[0][0], P[0][1], Q[0][0], Q[0][1], Q[1][0], Q[1][1], Q[2][0], Q[2][1])) return true;
  if (pointInTri2d(Q[0][0], Q[0][1], P[0][0], P[0][1], P[1][0], P[1][1], P[2][0], P[2][1])) return true;
  return false;
}

/**
 * True when the two triangles share interior points. Touching along a shared
 * edge or corner is not counted — callers filter those out first, because in a
 * well-formed mesh neighbours always touch.
 *
 * Möller's interval-overlap test, with one change that matters. The textbook
 * version branches on the *signs* of the vertex distances to the other plane,
 * and picks the vertex standing alone on its own side. When a vertex lies
 * exactly on that plane its sign is arbitrary, the branch picks a vertex whose
 * two partners have equal distances, and the interval formula divides by zero —
 * producing an infinite interval that overlaps everything. Adjacent triangles on
 * any curved surface hit this constantly, so an unguarded implementation reports
 * a clean sphere as riddled with self-intersections.
 *
 * The fix is to snap distances within `eps` to exactly zero before branching, so
 * a vertex on the plane is treated as on the plane. The normals are normalised
 * first, which makes `eps` a real distance in model units rather than a quantity
 * that scales with triangle area.
 */
export function triTriIntersect(p0, p1, p2, q0, q1, q2, eps) {
  const e1 = [0, 0, 0], e2 = [0, 0, 0], N1 = [0, 0, 0], N2 = [0, 0, 0];

  if (eps === undefined) {
    // No tolerance supplied: derive one from the size of the numbers involved.
    let scale = 0;
    for (const v of [p0, p1, p2, q0, q1, q2]) {
      for (let k = 0; k < 3; k++) {
        const a = Math.abs(v[k]);
        if (a > scale) scale = a;
      }
    }
    eps = Math.max(scale, 1) * 1e-9;
  }

  sub(q1, q0, e1); sub(q2, q0, e2); cross(e1, e2, N2);
  const len2 = Math.hypot(N2[0], N2[1], N2[2]);
  if (len2 === 0) return false; // degenerate triangle: no interior to share
  N2[0] /= len2; N2[1] /= len2; N2[2] /= len2;

  const d2 = -dot(N2, q0);
  let dp0 = dot(N2, p0) + d2, dp1 = dot(N2, p1) + d2, dp2 = dot(N2, p2) + d2;
  if (Math.abs(dp0) <= eps) dp0 = 0;
  if (Math.abs(dp1) <= eps) dp1 = 0;
  if (Math.abs(dp2) <= eps) dp2 = 0;
  if (dp0 > 0 && dp1 > 0 && dp2 > 0) return false;
  if (dp0 < 0 && dp1 < 0 && dp2 < 0) return false;

  sub(p1, p0, e1); sub(p2, p0, e2); cross(e1, e2, N1);
  const len1 = Math.hypot(N1[0], N1[1], N1[2]);
  if (len1 === 0) return false;
  N1[0] /= len1; N1[1] /= len1; N1[2] /= len1;

  const d1 = -dot(N1, p0);
  let dq0 = dot(N1, q0) + d1, dq1 = dot(N1, q1) + d1, dq2 = dot(N1, q2) + d1;
  if (Math.abs(dq0) <= eps) dq0 = 0;
  if (Math.abs(dq1) <= eps) dq1 = 0;
  if (Math.abs(dq2) <= eps) dq2 = 0;
  if (dq0 > 0 && dq1 > 0 && dq2 > 0) return false;
  if (dq0 < 0 && dq1 < 0 && dq2 < 0) return false;

  if (dp0 === 0 && dp1 === 0 && dp2 === 0) {
    return coplanarOverlap(N1, p0, p1, p2, q0, q1, q2);
  }

  const D = [0, 0, 0];
  cross(N1, N2, D);
  let index = 0;
  let maxc = Math.abs(D[0]);
  if (Math.abs(D[1]) > maxc) { maxc = Math.abs(D[1]); index = 1; }
  if (Math.abs(D[2]) > maxc) { index = 2; }

  /**
   * The span of one triangle along the planes' line of intersection. `a1` is
   * the vertex alone on its side, so the two divisions below always have a
   * non-zero denominator once the distances have been snapped.
   */
  const interval = (v0, v1, v2, a0, a1, a2) => {
    let A, B, C, x, y, z;
    if (a0 * a1 > 0) { A = v2; B = v0; C = v1; x = a2; y = a0; z = a1; }
    else if (a0 * a2 > 0) { A = v1; B = v0; C = v2; x = a1; y = a0; z = a2; }
    else if (a1 * a2 > 0 || a0 !== 0) { A = v0; B = v1; C = v2; x = a0; y = a1; z = a2; }
    else if (a1 !== 0) { A = v1; B = v0; C = v2; x = a1; y = a0; z = a2; }
    else { A = v2; B = v0; C = v1; x = a2; y = a0; z = a1; }
    const dy = x - y, dz = x - z;
    const t0 = dy === 0 ? A : A + (B - A) * (x / dy);
    const t1 = dz === 0 ? A : A + (C - A) * (x / dz);
    return t0 < t1 ? [t0, t1] : [t1, t0];
  };

  const [s0, s1] = interval(p0[index], p1[index], p2[index], dp0, dp1, dp2);
  const [t0, t1] = interval(q0[index], q1[index], q2[index], dq0, dq1, dq2);
  if (!Number.isFinite(s0) || !Number.isFinite(s1) || !Number.isFinite(t0) || !Number.isFinite(t1)) {
    return false;
  }
  // Intervals that merely abut describe triangles that touch, not overlap.
  return s1 > t0 + eps && t1 > s0 + eps;
}

/**
 * Do these two triangles share a corner?
 *
 * Compared through `weld`, a map of coincident vertices onto one
 * representative, so that two triangles meeting at the same *point* count as
 * neighbours even in an unwelded STL where they hold separate copies of it.
 * Without this, every seam in a raw STL is reported as a self-intersection.
 */
function sharesVertex(ix, weld, f, g) {
  const a = f * 3, b = g * 3;
  for (let i = 0; i < 3; i++) {
    const vi = weld[ix[a + i]];
    for (let j = 0; j < 3; j++) if (vi === weld[ix[b + j]]) return true;
  }
  return false;
}

/**
 * Find triangle pairs that pass through each other.
 * @param {Mesh} mesh
 * @param {{maxPairs?: number, bvh?: TriangleBVH, onProgress?: Function}} opts
 */
export function findSelfIntersections(mesh, opts = {}) {
  const maxPairs = opts.maxPairs ?? 50000;
  const bvh = opts.bvh || new TriangleBVH(mesh);
  const tolerance = opts.tolerance ?? mesh.defaultEpsilon();
  const weld = opts.weldMap || buildWeldMap(mesh, tolerance).remap;
  // Much tighter than the weld tolerance. This epsilon exists only to absorb
  // floating-point noise when deciding whether a vertex lies on a plane; sizing
  // it to the weld tolerance instead swallows real features, and a finely
  // tessellated model (where triangles near a pole are far smaller than the
  // weld tolerance) starts reporting itself as riddled with intersections.
  const intersectEps = opts.intersectionEpsilon
    ?? Math.max(mesh.bounds().diagonal, 1) * 1e-11;
  const ix = mesh.indices, p = mesh.positions;
  const nf = mesh.triangleCount;
  const pairs = [];
  const faces = new Set();
  let truncated = false;

  const mn = [0, 0, 0], mx = [0, 0, 0];
  const P = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  const Q = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  const load = (f, target) => {
    for (let k = 0; k < 3; k++) {
      const v = ix[f * 3 + k] * 3;
      target[k][0] = p[v]; target[k][1] = p[v + 1]; target[k][2] = p[v + 2];
    }
  };

  for (let f = 0; f < nf && !truncated; f++) {
    bvh.faceBox(f, mn, mx);
    load(f, P);
    bvh.queryBox(mn, mx, (g) => {
      if (g <= f) return;
      if (sharesVertex(ix, weld, f, g)) return;
      load(g, Q);
      if (triTriIntersect(P[0], P[1], P[2], Q[0], Q[1], Q[2], intersectEps)) {
        pairs.push(f, g);
        faces.add(f); faces.add(g);
        if (pairs.length / 2 >= maxPairs) { truncated = true; return false; }
      }
    });
    if (opts.onProgress && (f & 1023) === 0) opts.onProgress(f / nf);
  }

  return { pairs, faces, count: pairs.length / 2, truncated };
}

/**
 * Split intersecting pairs into the two cases, which need different answers.
 *
 *  - within one body: the surface folds through itself. A genuine defect; the
 *    inside of the model is undefined there and slicers guess.
 *  - between two separate bodies: two solids overlapping. Usually harmless —
 *    most slicers union overlapping solids — but it does mean the reported
 *    volume double-counts the shared region.
 *
 * Lumping them together is how a repair tool ends up deleting half a model to
 * "fix" two parts that were meant to touch.
 */
export function classifyIntersections(mesh, pairs, comp) {
  const components = comp || faceComponents(mesh, buildEdgeTable(mesh)).comp;
  const within = [], between = [];
  const withinFaces = new Set(), betweenFaces = new Set();
  for (let i = 0; i < pairs.length; i += 2) {
    const f = pairs[i], g = pairs[i + 1];
    if (components[f] === components[g]) {
      within.push(f, g);
      withinFaces.add(f); withinFaces.add(g);
    } else {
      between.push(f, g);
      betweenFaces.add(f); betweenFaces.add(g);
    }
  }
  return { within, between, withinFaces, betweenFaces, components };
}

/**
 * Cut out self-intersecting triangles and close the wounds.
 *
 * Deliberately destructive and off by default. It is the pragmatic fix — the
 * same one most repair tools reach for — but it removes real geometry.
 *
 * Two guards earn their keep. Only intersections *within* a single body are
 * cut, because overlapping separate bodies are usually intentional. And if the
 * cut would take more than `maxRemovalFraction` of the model, it is abandoned
 * untouched: past that point the patches intersect the next round of geometry,
 * the damage snowballs, and the tool quietly deletes the thing it was asked to
 * save.
 */
export function resolveSelfIntersections(mesh, opts = {}) {
  const {
    dilate = 0,
    maxRounds = 3,
    maxRemovalFraction = 0.25,
    scope = 'within-shell',
  } = opts;

  let current = mesh;
  let totalRemoved = 0, totalAdded = 0, rounds = 0;
  let remaining = 0;
  let aborted = null;

  for (let round = 0; round < maxRounds; round++) {
    const found = findSelfIntersections(current, { maxPairs: opts.maxPairs ?? 50000 });
    if (found.count === 0) { remaining = 0; break; }

    const classified = classifyIntersections(current, found.pairs);
    const target = scope === 'all' ? found.faces : classified.withinFaces;
    remaining = scope === 'all' ? found.count : classified.within.length / 2;
    if (target.size === 0) break;

    let drop = new Set(target);
    for (let d = 0; d < dilate; d++) {
      const vertexHit = new Set();
      for (const f of drop) {
        for (let k = 0; k < 3; k++) vertexHit.add(current.indices[f * 3 + k]);
      }
      const grown = new Set(drop);
      for (let f = 0; f < current.triangleCount; f++) {
        if (grown.has(f)) continue;
        const t = f * 3;
        if (vertexHit.has(current.indices[t]) || vertexHit.has(current.indices[t + 1]) ||
            vertexHit.has(current.indices[t + 2])) {
          grown.add(f);
        }
      }
      drop = grown;
    }

    const fraction = (totalRemoved + drop.size) / Math.max(1, mesh.triangleCount);
    if (fraction > maxRemovalFraction) {
      aborted = `cutting these out would delete ${Math.round(fraction * 100)}% of the model`;
      break;
    }

    rounds++;
    const keep = [];
    for (let f = 0; f < current.triangleCount; f++) {
      if (drop.has(f)) continue;
      const t = f * 3;
      keep.push(current.indices[t], current.indices[t + 1], current.indices[t + 2]);
    }
    totalRemoved += drop.size;
    const cut = new Mesh(current.positions, new Uint32Array(keep));
    cut.name = current.name; cut.unit = current.unit;

    const filled = fillHoles(cut);
    totalAdded += filled.trianglesAdded;
    current = filled.mesh;
  }

  if (aborted && totalRemoved === 0) {
    return { mesh, removed: 0, added: 0, rounds: 0, remaining, aborted };
  }
  return { mesh: current, removed: totalRemoved, added: totalAdded, rounds, remaining, aborted };
}
