/**
 * 3D convex hull, by quickhull.
 *
 * Needed for laying a model flat. The orientations a solid can actually rest in
 * are the faces of its convex hull, not the faces of its mesh — a tripod rests
 * on three feet that share no triangle, and a sphere's mesh has thousands of
 * faces it could never balance on. Working from the hull asks the right
 * question: which flat surface could this thing sit on without rocking?
 */

/**
 * @param {Float64Array} positions flat xyz
 * @param {{tolerance?: number}} opts
 * @returns {{faces: number[][], used: Set<number>, tolerance: number}}
 *   faces are triples of indices into `positions`, wound anticlockwise seen
 *   from outside.
 */
export function convexHull(positions, opts = {}) {
  const count = positions.length / 3;
  if (count < 4) return { faces: [], used: new Set(), tolerance: 0 };

  const at = (i, k) => positions[i * 3 + k];
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < count; i++) {
    for (let k = 0; k < 3; k++) {
      const v = at(i, k);
      if (v < min[k]) min[k] = v;
      if (v > max[k]) max[k] = v;
    }
  }
  const diagonal = Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
  const eps = opts.tolerance ?? Math.max(diagonal * 1e-10, Number.MIN_VALUE);

  // --- starting tetrahedron, from the most spread-out points we can find ---
  const extremes = [];
  for (let k = 0; k < 3; k++) {
    let lo = 0, hi = 0;
    for (let i = 1; i < count; i++) {
      if (at(i, k) < at(lo, k)) lo = i;
      if (at(i, k) > at(hi, k)) hi = i;
    }
    extremes.push(lo, hi);
  }

  let a = -1, b = -1, best = -1;
  for (let i = 0; i < extremes.length; i++) {
    for (let j = i + 1; j < extremes.length; j++) {
      const d = distance2(positions, extremes[i], extremes[j]);
      if (d > best) { best = d; a = extremes[i]; b = extremes[j]; }
    }
  }
  if (best <= eps * eps) return { faces: [], used: new Set(), tolerance: eps };

  let c = -1;
  best = -1;
  for (let i = 0; i < count; i++) {
    const d = distanceToLine2(positions, i, a, b);
    if (d > best) { best = d; c = i; }
  }
  if (c < 0 || best <= eps * eps) return { faces: [], used: new Set(), tolerance: eps };

  const normal = triangleNormal(positions, a, b, c);
  let d = -1;
  best = -1;
  for (let i = 0; i < count; i++) {
    const dist = Math.abs(planeDistance(positions, i, a, normal));
    if (dist > best) { best = dist; d = i; }
  }
  // Everything is coplanar: a flat sheet has no hull volume to speak of.
  if (d < 0 || best <= eps) return { faces: [], used: new Set(), tolerance: eps, degenerate: 'coplanar' };

  let faces = [];
  const addFace = (i, j, k) => {
    const n = triangleNormal(positions, i, j, k);
    faces.push({ v: [i, j, k], n, offset: n[0] * at(i, 0) + n[1] * at(i, 1) + n[2] * at(i, 2), outside: [] });
  };
  if (planeDistance(positions, d, a, normal) < 0) {
    addFace(a, b, c);
    addFace(a, d, b);
    addFace(b, d, c);
    addFace(c, d, a);
  } else {
    addFace(a, c, b);
    addFace(a, b, d);
    addFace(b, c, d);
    addFace(c, a, d);
  }

  const seen = new Set([a, b, c, d]);
  const above = (face, i) =>
    face.n[0] * at(i, 0) + face.n[1] * at(i, 1) + face.n[2] * at(i, 2) - face.offset;

  for (let i = 0; i < count; i++) {
    if (seen.has(i)) continue;
    for (const face of faces) {
      if (above(face, i) > eps) { face.outside.push(i); break; }
    }
  }

  // --- grow the hull, one furthest point at a time ---
  const guard = count * 6 + 256;
  let steps = 0;
  while (steps++ < guard) {
    const face = faces.find((f) => f.outside.length > 0);
    if (!face) break;

    let apex = -1, far = -eps;
    for (const i of face.outside) {
      const dist = above(face, i);
      if (dist > far) { far = dist; apex = i; }
    }
    if (apex < 0) { face.outside.length = 0; continue; }

    const visible = [];
    const hidden = [];
    for (const f of faces) (above(f, apex) > eps ? visible : hidden).push(f);

    // The horizon is where the lit faces end. Faces are wound consistently, so
    // each shared edge appears once in each direction; an edge whose reverse is
    // not also lit is on the boundary.
    const lit = new Set();
    for (const f of visible) {
      lit.add(key(f.v[0], f.v[1]));
      lit.add(key(f.v[1], f.v[2]));
      lit.add(key(f.v[2], f.v[0]));
    }
    const horizon = [];
    for (const f of visible) {
      for (let e = 0; e < 3; e++) {
        const from = f.v[e], to = f.v[(e + 1) % 3];
        if (!lit.has(key(to, from))) horizon.push([from, to]);
      }
    }
    if (horizon.length === 0) { face.outside.length = 0; continue; }

    const orphans = [];
    for (const f of visible) for (const i of f.outside) if (i !== apex) orphans.push(i);

    faces = hidden;
    const fresh = [];
    for (const [from, to] of horizon) {
      const n = triangleNormal(positions, from, to, apex);
      if (n[0] === 0 && n[1] === 0 && n[2] === 0) continue; // sliver, skip
      const f = {
        v: [from, to, apex], n,
        offset: n[0] * at(from, 0) + n[1] * at(from, 1) + n[2] * at(from, 2),
        outside: [],
      };
      faces.push(f);
      fresh.push(f);
    }

    for (const i of orphans) {
      for (const f of fresh) {
        if (above(f, i) > eps) { f.outside.push(i); break; }
      }
    }
  }

  const used = new Set();
  const out = [];
  for (const f of faces) {
    out.push(f.v);
    used.add(f.v[0]); used.add(f.v[1]); used.add(f.v[2]);
  }
  return { faces: out, used, tolerance: eps };
}

function key(a, b) { return a * 16777216 + b; }

function distance2(p, i, j) {
  const dx = p[i * 3] - p[j * 3];
  const dy = p[i * 3 + 1] - p[j * 3 + 1];
  const dz = p[i * 3 + 2] - p[j * 3 + 2];
  return dx * dx + dy * dy + dz * dz;
}

function distanceToLine2(p, i, a, b) {
  const ax = p[a * 3], ay = p[a * 3 + 1], az = p[a * 3 + 2];
  const ux = p[b * 3] - ax, uy = p[b * 3 + 1] - ay, uz = p[b * 3 + 2] - az;
  const wx = p[i * 3] - ax, wy = p[i * 3 + 1] - ay, wz = p[i * 3 + 2] - az;
  const cx = uy * wz - uz * wy, cy = uz * wx - ux * wz, cz = ux * wy - uy * wx;
  const len2 = ux * ux + uy * uy + uz * uz;
  if (len2 === 0) return wx * wx + wy * wy + wz * wz;
  return (cx * cx + cy * cy + cz * cz) / len2;
}

function triangleNormal(p, i, j, k) {
  const ax = p[i * 3], ay = p[i * 3 + 1], az = p[i * 3 + 2];
  const ux = p[j * 3] - ax, uy = p[j * 3 + 1] - ay, uz = p[j * 3 + 2] - az;
  const vx = p[k * 3] - ax, vy = p[k * 3 + 1] - ay, vz = p[k * 3 + 2] - az;
  let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  const len = Math.hypot(nx, ny, nz);
  if (len === 0) return [0, 0, 0];
  return [nx / len, ny / len, nz / len];
}

function planeDistance(p, i, origin, n) {
  return n[0] * (p[i * 3] - p[origin * 3])
       + n[1] * (p[i * 3 + 1] - p[origin * 3 + 1])
       + n[2] * (p[i * 3 + 2] - p[origin * 3 + 2]);
}
