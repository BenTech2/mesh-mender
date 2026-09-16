/**
 * Hole filling.
 *
 * Small and medium holes are closed with a minimum-weight triangulation
 * (Barequet-Sharir / Liepa): every possible triangulation of the boundary
 * polygon is scored and the best one chosen by dynamic programming. The score
 * is "flattest first, smallest second" — the worst dihedral angle in the patch
 * dominates, with total area as the tie-break. Scoring on area alone is the
 * usual shortcut and it visibly creases holes that sit on a curved surface.
 *
 * Very large loops fall back to a fan from a new centre vertex: O(n^3) stops
 * being reasonable somewhere around a few hundred edges, and a hole that big is
 * usually a missing face rather than a defect worth agonising over.
 */
import { Mesh, edgeKey } from './core.js';
import { buildEdgeTable, boundaryLoops } from './topology.js';

const DP_LIMIT = 250;

function sub(p, a, b, out) {
  out[0] = p[a * 3] - p[b * 3];
  out[1] = p[a * 3 + 1] - p[b * 3 + 1];
  out[2] = p[a * 3 + 2] - p[b * 3 + 2];
  return out;
}
function cross(u, v, out) {
  out[0] = u[1] * v[2] - u[2] * v[1];
  out[1] = u[2] * v[0] - u[0] * v[2];
  out[2] = u[0] * v[1] - u[1] * v[0];
  return out;
}

/** Unit normal and area of the triangle through three vertex indices. */
function triNormalArea(p, a, b, c, n) {
  const u = [0, 0, 0], v = [0, 0, 0];
  sub(p, b, a, u); sub(p, c, a, v);
  cross(u, v, n);
  const len = Math.hypot(n[0], n[1], n[2]);
  if (len > 0) { n[0] /= len; n[1] /= len; n[2] /= len; }
  return len / 2;
}

function angleBetween(n1, n2) {
  if (!n1 || !n2) return 0;
  let d = n1[0] * n2[0] + n1[1] * n2[1] + n1[2] * n2[2];
  d = Math.max(-1, Math.min(1, d));
  return Math.acos(d);
}

/** Lexicographic compare of (worst dihedral, total area). */
function better(a1, r1, a2, r2) {
  if (a1 < a2 - 1e-9) return true;
  if (a1 > a2 + 1e-9) return false;
  return r1 < r2;
}

/**
 * Triangulate one closed loop of vertex indices, returning triangles as index
 * triples. `edgeNormals[i]` is the normal of the existing mesh face across the
 * loop edge i -> i+1, used to keep the patch tangent to its surroundings.
 */
export function triangulateLoop(positions, loop, edgeNormals) {
  const n = loop.length;
  const tris = [];
  if (n < 3) return tris;
  if (n === 3) { tris.push(loop[0], loop[1], loop[2]); return tris; }

  const W_ANG = new Float64Array(n * n);
  const W_AREA = new Float64Array(n * n);
  const LAM = new Int32Array(n * n).fill(-1);
  const at = (i, j) => i * n + j;
  const normalCache = new Map();
  const patchNormal = (i, m, j) => {
    const key = i * n * n + m * n + j;
    let v = normalCache.get(key);
    if (!v) {
      const nrm = [0, 0, 0];
      const area = triNormalArea(positions, loop[i], loop[m], loop[j], nrm);
      v = { nrm, area };
      normalCache.set(key, v);
    }
    return v;
  };

  // Normal of the triangle sitting on edge (i,j) inside the best sub-patch,
  // or the neighbouring mesh face when (i,j) is an original loop edge.
  const edgeNormal = (i, j) => {
    if (j === i + 1) return edgeNormals ? edgeNormals[i] : null;
    const m = LAM[at(i, j)];
    if (m < 0) return null;
    return patchNormal(i, m, j).nrm;
  };

  for (let i = 0; i + 2 < n; i++) {
    const t = patchNormal(i, i + 1, i + 2);
    W_AREA[at(i, i + 2)] = t.area;
    W_ANG[at(i, i + 2)] = Math.max(
      angleBetween(t.nrm, edgeNormals ? edgeNormals[i] : null),
      angleBetween(t.nrm, edgeNormals ? edgeNormals[i + 1] : null),
    );
    LAM[at(i, i + 2)] = i + 1;
  }

  for (let span = 3; span < n; span++) {
    for (let i = 0; i + span < n; i++) {
      const j = i + span;
      let bestAng = Infinity, bestArea = Infinity, bestM = -1;
      for (let m = i + 1; m < j; m++) {
        const t = patchNormal(i, m, j);
        const ang = Math.max(
          W_ANG[at(i, m)],
          W_ANG[at(m, j)],
          angleBetween(t.nrm, edgeNormal(i, m)),
          angleBetween(t.nrm, edgeNormal(m, j)),
          // closing the polygon also meets the original edge (n-1 -> 0)
          (i === 0 && j === n - 1 && edgeNormals) ? angleBetween(t.nrm, edgeNormals[n - 1]) : 0,
        );
        const area = W_AREA[at(i, m)] + W_AREA[at(m, j)] + t.area;
        if (bestM < 0 || better(ang, area, bestAng, bestArea)) {
          bestAng = ang; bestArea = area; bestM = m;
        }
      }
      W_ANG[at(i, j)] = bestAng;
      W_AREA[at(i, j)] = bestArea;
      LAM[at(i, j)] = bestM;
    }
  }

  const stack = [[0, n - 1]];
  while (stack.length) {
    const [i, j] = stack.pop();
    if (j - i < 2) continue;
    const m = LAM[at(i, j)];
    if (m < 0) continue;
    tris.push(loop[i], loop[m], loop[j]);
    stack.push([i, m], [m, j]);
  }
  return tris;
}

/** Fan a big loop from a fresh vertex at its centroid. */
function fanLoop(positions, loop, extraVertices) {
  const n = loop.length;
  let cx = 0, cy = 0, cz = 0;
  for (const v of loop) { cx += positions[v * 3]; cy += positions[v * 3 + 1]; cz += positions[v * 3 + 2]; }
  cx /= n; cy /= n; cz /= n;
  const centre = extraVertices.push(cx, cy, cz);
  const centreIndex = (positions.length + centre - 3) / 3;
  const tris = [];
  for (let i = 0; i < n; i++) tris.push(loop[i], loop[(i + 1) % n], centreIndex);
  return tris;
}

/**
 * Close every boundary loop in the mesh.
 * @param {Mesh} mesh
 * @param {{maxLoopEdges?: number, dpLimit?: number}} opts
 */
export function fillHoles(mesh, opts = {}) {
  const dpLimit = opts.dpLimit ?? DP_LIMIT;
  const maxLoopEdges = opts.maxLoopEdges ?? Infinity;

  const edges = buildEdgeTable(mesh);
  const loops = boundaryLoops(mesh, edges);
  if (loops.length === 0) {
    return { mesh, holesFilled: 0, trianglesAdded: 0, holes: [], skipped: 0 };
  }

  // Normal of the mesh face on the far side of each boundary edge.
  const faceNormalFor = (a, b) => {
    const e = edges.map.get(edgeKey(a, b));
    if (e === undefined) return null;
    const uses = edges.uses[e];
    if (uses.length !== 1) return null;
    const n = [0, 0, 0];
    mesh.faceNormal(uses[0] >> 1, n);
    return n;
  };

  const extraVertices = [];
  const newTris = [];
  const holes = [];
  let skipped = 0;

  for (const loop of loops) {
    const n = loop.length;
    let perimeter = 0;
    for (let i = 0; i < n; i++) {
      const a = loop[i] * 3, b = loop[(i + 1) % n] * 3;
      perimeter += Math.hypot(
        mesh.positions[b] - mesh.positions[a],
        mesh.positions[b + 1] - mesh.positions[a + 1],
        mesh.positions[b + 2] - mesh.positions[a + 2],
      );
    }
    if (n > maxLoopEdges) {
      skipped++;
      holes.push({ edges: n, perimeter, filled: false, triangles: 0 });
      continue;
    }

    let tris;
    if (n <= dpLimit) {
      const edgeNormals = new Array(n);
      for (let i = 0; i < n; i++) edgeNormals[i] = faceNormalFor(loop[i], loop[(i + 1) % n]);
      tris = triangulateLoop(mesh.positions, loop, edgeNormals);
    } else {
      tris = fanLoop(mesh.positions, loop, extraVertices);
    }
    for (const t of tris) newTris.push(t);
    holes.push({ edges: n, perimeter, filled: true, triangles: tris.length / 3 });
  }

  if (newTris.length === 0) {
    return { mesh, holesFilled: 0, trianglesAdded: 0, holes, skipped };
  }

  const positions = new Float64Array(mesh.positions.length + extraVertices.length);
  positions.set(mesh.positions);
  positions.set(extraVertices, mesh.positions.length);
  const indices = new Uint32Array(mesh.indices.length + newTris.length);
  indices.set(mesh.indices);
  indices.set(newTris, mesh.indices.length);

  const out = new Mesh(positions, indices);
  out.name = mesh.name; out.unit = mesh.unit;
  return {
    mesh: out,
    holesFilled: holes.filter((h) => h.filled).length,
    trianglesAdded: newTris.length / 3,
    holes,
    skipped,
  };
}
