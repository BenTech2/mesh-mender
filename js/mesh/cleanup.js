/**
 * Vertex/face hygiene. These run first in the repair pipeline: almost every
 * "unrepairable" STL is really a clean mesh hiding behind duplicated vertices,
 * because the format stores every triangle independently and nothing tells the
 * reader that two corners at the same place are the same corner.
 */
import { Mesh } from './core.js';

/**
 * Merge vertices that lie within `eps` of each other.
 *
 * A uniform spatial hash with a cell the size of the tolerance; each vertex
 * probes the 27 surrounding cells and merges into the first representative
 * genuinely within `eps`. Probing neighbours (rather than trusting the cell)
 * is what stops two vertices a nanometre apart being kept separate purely
 * because a cell boundary ran between them.
 */
/**
 * The vertex-merge map on its own, without rebuilding the mesh.
 *
 * `remap[v]` is the index of the representative v collapses onto, and
 * `kept[i]` is the original vertex each representative came from. Separated out
 * because self-intersection testing needs to know which corners are really the
 * same point without actually welding anything.
 */
export function buildWeldMap(mesh, eps) {
  const p = mesh.positions;
  const nv = mesh.vertexCount;
  const remap = new Uint32Array(nv);
  const kept = [];

  if (!(eps > 0)) {
    const map = new Map();
    for (let v = 0; v < nv; v++) {
      const i = v * 3;
      const key = p[i] + ',' + p[i + 1] + ',' + p[i + 2];
      const hit = map.get(key);
      if (hit !== undefined) { remap[v] = hit; continue; }
      const id = kept.length;
      map.set(key, id);
      kept.push(v);
      remap[v] = id;
    }
    return { remap, kept, merged: nv - kept.length };
  }

  const inv = 1 / eps;
  const eps2 = eps * eps;
  const buckets = new Map();
  const hash = (x, y, z) =>
    (Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791)) >>> 0;

  for (let v = 0; v < nv; v++) {
    const i = v * 3;
    const x = p[i], y = p[i + 1], z = p[i + 2];
    const cx = Math.floor(x * inv), cy = Math.floor(y * inv), cz = Math.floor(z * inv);
    let found = -1;
    outer:
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          const list = buckets.get(hash(cx + dx, cy + dy, cz + dz));
          if (!list) continue;
          for (let k = 0; k < list.length; k++) {
            const id = list[k];
            const j = kept[id] * 3;
            const ddx = p[j] - x, ddy = p[j + 1] - y, ddz = p[j + 2] - z;
            if (ddx * ddx + ddy * ddy + ddz * ddz <= eps2) { found = id; break outer; }
          }
        }
      }
    }
    if (found >= 0) { remap[v] = found; continue; }
    const id = kept.length;
    kept.push(v);
    remap[v] = id;
    const h = hash(cx, cy, cz);
    const list = buckets.get(h);
    if (list) list.push(id); else buckets.set(h, [id]);
  }
  return { remap, kept, merged: nv - kept.length };
}

/**
 * Merge vertices that lie within `eps` of each other.
 *
 * A uniform spatial hash with a cell the size of the tolerance; each vertex
 * probes the 27 surrounding cells and merges into the first representative
 * genuinely within `eps`. Probing neighbours (rather than trusting the cell)
 * is what stops two vertices a nanometre apart being kept separate purely
 * because a cell boundary ran between them.
 */
export function weldVertices(mesh, eps) {
  const { remap, kept, merged } = buildWeldMap(mesh, eps);
  if (merged === 0) return { mesh, merged: 0 };

  const p = mesh.positions;
  const positions = new Float64Array(kept.length * 3);
  for (let i = 0; i < kept.length; i++) {
    const s = kept[i] * 3, d = i * 3;
    positions[d] = p[s]; positions[d + 1] = p[s + 1]; positions[d + 2] = p[s + 2];
  }
  const indices = new Uint32Array(mesh.indices.length);
  for (let i = 0; i < indices.length; i++) indices[i] = remap[mesh.indices[i]];

  const out = new Mesh(positions, indices);
  out.name = mesh.name; out.unit = mesh.unit;
  return { mesh: out, merged };
}

/**
 * Drop triangles that enclose no area: repeated corners, or three points so
 * nearly collinear that they are a sliver. Slicers turn these into stray
 * segments or simply crash on them.
 */
export function removeDegenerateTriangles(mesh, areaEps) {
  const ix = mesh.indices;
  const keep = [];
  let removedRepeat = 0, removedSliver = 0;
  for (let f = 0, t = 0; t < ix.length; f++, t += 3) {
    const a = ix[t], b = ix[t + 1], c = ix[t + 2];
    if (a === b || b === c || a === c) { removedRepeat++; continue; }
    if (areaEps > 0 && mesh.triangleArea(f) <= areaEps) { removedSliver++; continue; }
    keep.push(a, b, c);
  }
  const removed = removedRepeat + removedSliver;
  if (removed === 0) return { mesh, removed: 0, removedRepeat: 0, removedSliver: 0 };
  const out = new Mesh(mesh.positions, new Uint32Array(keep));
  out.name = mesh.name; out.unit = mesh.unit;
  return { mesh: out, removed, removedRepeat, removedSliver };
}

/**
 * Remove repeated triangles.
 *
 * Two flavours, and they mean different things:
 *  - the same triangle wound the same way twice: a straight duplicate, drop one.
 *  - the same triangle wound both ways: a zero-thickness fin. It has no volume,
 *    confuses every inside/outside test, and both copies have to go. That can
 *    open a hole, which the hole-filling stage then closes properly.
 */
export function removeDuplicateTriangles(mesh, { removeOpposite = true } = {}) {
  const ix = mesh.indices;
  const nf = mesh.triangleCount;
  const groups = new Map();
  for (let f = 0, t = 0; t < ix.length; f++, t += 3) {
    let a = ix[t], b = ix[t + 1], c = ix[t + 2];
    // sort the three and track swap parity: even parity = same winding
    let parity = 0;
    if (a > b) { const s = a; a = b; b = s; parity ^= 1; }
    if (b > c) { const s = b; b = c; c = s; parity ^= 1; }
    if (a > b) { const s = a; a = b; b = s; parity ^= 1; }
    const key = a + '_' + b + '_' + c;
    let g = groups.get(key);
    if (!g) { g = []; groups.set(key, g); }
    g.push(f * 2 + parity);
  }

  const drop = new Uint8Array(nf);
  let identical = 0, opposite = 0;
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    const even = [], odd = [];
    for (const v of g) (v & 1 ? odd : even).push(v >> 1);
    // collapse each winding down to one representative
    for (let i = 1; i < even.length; i++) { drop[even[i]] = 1; identical++; }
    for (let i = 1; i < odd.length; i++) { drop[odd[i]] = 1; identical++; }
    if (removeOpposite && even.length && odd.length) {
      drop[even[0]] = 1; drop[odd[0]] = 1; opposite += 2;
    }
  }

  const removed = identical + opposite;
  if (removed === 0) return { mesh, removed: 0, identical: 0, opposite: 0 };
  const keep = new Uint32Array((nf - removed) * 3);
  let o = 0;
  for (let f = 0; f < nf; f++) {
    if (drop[f]) continue;
    const t = f * 3;
    keep[o++] = ix[t]; keep[o++] = ix[t + 1]; keep[o++] = ix[t + 2];
  }
  const out = new Mesh(mesh.positions, keep);
  out.name = mesh.name; out.unit = mesh.unit;
  return { mesh: out, removed, identical, opposite };
}

/**
 * Collapse edges of zero (or near-zero) length, merging their two ends.
 *
 * Deleting a zero-area triangle is the obvious move and the wrong one: it
 * leaves a three-edge hole that fills straight back in as the same triangle.
 * Collapsing the offending edge removes the triangle and mends its neighbours
 * in one step.
 *
 * Only vertices already joined by an edge are merged — never two that merely
 * happen to sit at the same point — so this cannot re-join surfaces that were
 * deliberately separated.
 */
export function collapseDegenerateEdges(mesh, eps = 0) {
  const ix = mesh.indices, p = mesh.positions;
  const parent = new Uint32Array(mesh.vertexCount);
  for (let i = 0; i < parent.length; i++) parent[i] = i;
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };

  const eps2 = eps * eps;
  let collapsed = 0;
  for (let t = 0; t < ix.length; t += 3) {
    for (let k = 0; k < 3; k++) {
      const a = ix[t + k], b = ix[t + (k + 1) % 3];
      if (a === b) continue;
      const ia = a * 3, ib = b * 3;
      const dx = p[ib] - p[ia], dy = p[ib + 1] - p[ia + 1], dz = p[ib + 2] - p[ia + 2];
      if (dx * dx + dy * dy + dz * dz > eps2) continue;
      const ra = find(a), rb = find(b);
      if (ra !== rb) { parent[ra] = rb; collapsed++; }
    }
  }
  if (collapsed === 0) return { mesh, collapsed: 0, removed: 0 };

  const indices = new Uint32Array(ix.length);
  for (let i = 0; i < ix.length; i++) indices[i] = find(ix[i]);
  const merged = new Mesh(mesh.positions, indices);
  merged.name = mesh.name; merged.unit = mesh.unit;

  const cleaned = removeDegenerateTriangles(merged, 0);
  const compacted = removeUnusedVertices(cleaned.mesh);
  return { mesh: compacted.mesh, collapsed, removed: cleaned.removed };
}

/** Compact away vertices no triangle refers to. */
export function removeUnusedVertices(mesh) {
  const nv = mesh.vertexCount;
  const ix = mesh.indices;
  const remap = new Int32Array(nv).fill(-1);
  let n = 0;
  for (let i = 0; i < ix.length; i++) {
    const v = ix[i];
    if (remap[v] === -1) remap[v] = n++;
  }
  if (n === nv) return { mesh, removed: 0 };
  const positions = new Float64Array(n * 3);
  for (let v = 0; v < nv; v++) {
    const d = remap[v];
    if (d === -1) continue;
    positions[d * 3] = mesh.positions[v * 3];
    positions[d * 3 + 1] = mesh.positions[v * 3 + 1];
    positions[d * 3 + 2] = mesh.positions[v * 3 + 2];
  }
  const indices = new Uint32Array(ix.length);
  for (let i = 0; i < ix.length; i++) indices[i] = remap[ix[i]];
  const out = new Mesh(positions, indices);
  out.name = mesh.name; out.unit = mesh.unit;
  return { mesh: out, removed: nv - n };
}
