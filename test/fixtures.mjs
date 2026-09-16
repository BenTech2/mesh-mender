/** Shared geometry generators for the tests. */
import { Mesh } from '../js/mesh/core.js';

export const CUBE_POSITIONS = [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1];
export const CUBE_INDICES = [
  0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5,
  0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7,
];

export function cube(scale = 1, offset = [0, 0, 0]) {
  const positions = CUBE_POSITIONS.map((v, i) => v * scale + offset[i % 3]);
  return new Mesh(new Float64Array(positions), new Uint32Array(CUBE_INDICES));
}

/** The same cube as an STL-style triangle soup: no shared vertices at all. */
export function cubeSoup(scale = 1, offset = [0, 0, 0]) {
  const positions = CUBE_POSITIONS.map((v, i) => v * scale + offset[i % 3]);
  const coords = [];
  for (const i of CUBE_INDICES) coords.push(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
  return Mesh.fromSoup(coords);
}

export function sphereTriangles(rings, segments, radius, offset = [0, 0, 0]) {
  const grid = [];
  for (let r = 0; r <= rings; r++) {
    const phi = (r / rings) * Math.PI;
    const row = [];
    for (let s = 0; s < segments; s++) {
      const theta = (s / segments) * Math.PI * 2;
      row.push([
        offset[0] + radius * Math.sin(phi) * Math.cos(theta),
        offset[1] + radius * Math.sin(phi) * Math.sin(theta),
        offset[2] + radius * Math.cos(phi),
      ]);
    }
    grid.push(row);
  }
  const tris = [];
  for (let r = 0; r < rings; r++) {
    for (let s = 0; s < segments; s++) {
      const s2 = (s + 1) % segments;
      const a = grid[r][s], b = grid[r][s2], c = grid[r + 1][s2], d = grid[r + 1][s];
      // Wound so the normals face outwards: the surface parametrisation runs
      // the other way, and a fixture that is quietly inside-out makes every
      // volume assertion below negative for the wrong reason.
      if (r !== 0) tris.push([a, c, b]);
      if (r !== rings - 1) tris.push([a, d, c]);
    }
  }
  return tris;
}

export function meshFromTriangles(tris) {
  const coords = [];
  for (const t of tris) for (const v of t) coords.push(v[0], v[1], v[2]);
  return Mesh.fromSoup(coords);
}

export function sphere(rings, segments, radius, offset) {
  return meshFromTriangles(sphereTriangles(rings, segments, radius, offset));
}

/** Deterministic pseudo-random, so failures reproduce. */
export function rng(seed = 12345) {
  let s = seed;
  return () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
}

/** An independent triangle-triangle test to check the fast one against. */
export function referenceIntersect(A, B) {
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const segTri = (s, e, T) => {
    const dir = sub(e, s);
    const ed1 = sub(T[1], T[0]), ed2 = sub(T[2], T[0]);
    const h = cross(dir, ed2);
    const a = dot(ed1, h);
    if (Math.abs(a) < 1e-14) return false;
    const f = 1 / a;
    const s2 = sub(s, T[0]);
    const u = f * dot(s2, h);
    if (u < 1e-9 || u > 1 - 1e-9) return false;
    const q = cross(s2, ed1);
    const v = f * dot(dir, q);
    if (v < 1e-9 || u + v > 1 - 1e-9) return false;
    const t = f * dot(ed2, q);
    return t > 1e-9 && t < 1 - 1e-9;
  };
  for (let i = 0; i < 3; i++) {
    if (segTri(A[i], A[(i + 1) % 3], B)) return true;
    if (segTri(B[i], B[(i + 1) % 3], A)) return true;
  }
  return false;
}

export function triangleOf(mesh, f) {
  const out = [];
  for (let k = 0; k < 3; k++) {
    const v = mesh.indices[f * 3 + k] * 3;
    out.push([mesh.positions[v], mesh.positions[v + 1], mesh.positions[v + 2]]);
  }
  return out;
}
