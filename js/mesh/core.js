/**
 * Core indexed-triangle mesh.
 *
 * Positions are kept in Float64Array: repair work compares coordinates against
 * small tolerances, and float32 rounding was the source of most "why is this
 * edge still open" bugs during development.
 */

export class Mesh {
  /**
   * @param {Float64Array} positions flat xyz, length = 3 * vertexCount
   * @param {Uint32Array}  indices   flat triples, length = 3 * triangleCount
   */
  constructor(positions, indices) {
    this.positions = positions instanceof Float64Array ? positions : new Float64Array(positions);
    this.indices = indices instanceof Uint32Array ? indices : new Uint32Array(indices);
    this.name = '';
    /** Original file units, purely informational. */
    this.unit = 'millimeter';
  }

  get vertexCount() { return this.positions.length / 3; }
  get triangleCount() { return this.indices.length / 3; }

  /** Build from an unindexed triangle soup (what STL gives us). */
  static fromSoup(coords) {
    const n = coords.length / 3;
    const idx = new Uint32Array(n);
    for (let i = 0; i < n; i++) idx[i] = i;
    return new Mesh(new Float64Array(coords), idx);
  }

  static empty() { return new Mesh(new Float64Array(0), new Uint32Array(0)); }

  clone() {
    const m = new Mesh(this.positions.slice(), this.indices.slice());
    m.name = this.name;
    m.unit = this.unit;
    return m;
  }

  /** Copy vertex v into the supplied 3-element target. */
  getVertex(v, out) {
    const p = v * 3;
    out[0] = this.positions[p];
    out[1] = this.positions[p + 1];
    out[2] = this.positions[p + 2];
    return out;
  }

  /** Vertex indices of triangle f. */
  getTriangle(f, out) {
    const t = f * 3;
    out[0] = this.indices[t];
    out[1] = this.indices[t + 1];
    out[2] = this.indices[t + 2];
    return out;
  }

  bounds() {
    const p = this.positions;
    if (p.length === 0) {
      return { min: [0, 0, 0], max: [0, 0, 0], size: [0, 0, 0], center: [0, 0, 0], diagonal: 0 };
    }
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < p.length; i += 3) {
      for (let a = 0; a < 3; a++) {
        const v = p[i + a];
        if (v < min[a]) min[a] = v;
        if (v > max[a]) max[a] = v;
      }
    }
    const size = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
    return {
      min, max, size,
      center: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2],
      diagonal: Math.hypot(size[0], size[1], size[2]),
    };
  }

  surfaceArea() {
    const p = this.positions, ix = this.indices;
    let area = 0;
    for (let t = 0; t < ix.length; t += 3) {
      const a = ix[t] * 3, b = ix[t + 1] * 3, c = ix[t + 2] * 3;
      const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
      const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
      const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
      area += Math.hypot(cx, cy, cz);
    }
    return area / 2;
  }

  /**
   * Signed volume via the divergence theorem. Only meaningful once the mesh is
   * closed and consistently wound; a negative result on a closed mesh means the
   * normals point inward.
   */
  signedVolume() {
    const p = this.positions, ix = this.indices;
    let vol = 0;
    for (let t = 0; t < ix.length; t += 3) {
      const a = ix[t] * 3, b = ix[t + 1] * 3, c = ix[t + 2] * 3;
      const ax = p[a], ay = p[a + 1], az = p[a + 2];
      const bx = p[b], by = p[b + 1], bz = p[b + 2];
      const cx = p[c], cy = p[c + 1], cz = p[c + 2];
      vol += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
    }
    return vol / 6;
  }

  /** Twice the triangle area (i.e. the cross-product length) — cheap degeneracy test. */
  triangleArea(f) {
    const p = this.positions, ix = this.indices, t = f * 3;
    const a = ix[t] * 3, b = ix[t + 1] * 3, c = ix[t + 2] * 3;
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    return Math.hypot(cx, cy, cz) / 2;
  }

  faceNormal(f, out) {
    const p = this.positions, ix = this.indices, t = f * 3;
    const a = ix[t] * 3, b = ix[t + 1] * 3, c = ix[t + 2] * 3;
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    out[0] = nx / len; out[1] = ny / len; out[2] = nz / len;
    return out;
  }

  /** Apply a column-major 4x4 matrix (three.js element order). */
  applyMatrix4(e) {
    const p = this.positions;
    for (let i = 0; i < p.length; i += 3) {
      const x = p[i], y = p[i + 1], z = p[i + 2];
      const w = e[3] * x + e[7] * y + e[11] * z + e[15] || 1;
      p[i] = (e[0] * x + e[4] * y + e[8] * z + e[12]) / w;
      p[i + 1] = (e[1] * x + e[5] * y + e[9] * z + e[13]) / w;
      p[i + 2] = (e[2] * x + e[6] * y + e[10] * z + e[14]) / w;
    }
    // A mirroring transform flips winding; undo that so normals stay meaningful.
    const det =
      e[0] * (e[5] * e[10] - e[9] * e[6]) -
      e[4] * (e[1] * e[10] - e[9] * e[2]) +
      e[8] * (e[1] * e[6] - e[5] * e[2]);
    if (det < 0) this.flipAll();
    return this;
  }

  flipAll() {
    const ix = this.indices;
    for (let t = 0; t < ix.length; t += 3) {
      const tmp = ix[t + 1];
      ix[t + 1] = ix[t + 2];
      ix[t + 2] = tmp;
    }
    return this;
  }

  translate(dx, dy, dz) {
    const p = this.positions;
    for (let i = 0; i < p.length; i += 3) { p[i] += dx; p[i + 1] += dy; p[i + 2] += dz; }
    return this;
  }

  scale(sx, sy = sx, sz = sx) {
    const p = this.positions;
    for (let i = 0; i < p.length; i += 3) { p[i] *= sx; p[i + 1] *= sy; p[i + 2] *= sz; }
    if (sx * sy * sz < 0) this.flipAll();
    return this;
  }

  /** A sensible default tolerance: relative to object size, never zero. */
  defaultEpsilon() {
    const d = this.bounds().diagonal;
    return d > 0 ? d * 1e-6 : 1e-9;
  }

  /** Structured-clone friendly payload for worker messaging. */
  toTransfer() {
    return { positions: this.positions, indices: this.indices, name: this.name, unit: this.unit };
  }

  static fromTransfer(o) {
    const m = new Mesh(o.positions, o.indices);
    m.name = o.name || '';
    m.unit = o.unit || 'millimeter';
    return m;
  }

  /** Non-indexed float32 positions + normals, ready for a GPU buffer. */
  toRenderBuffers() {
    const p = this.positions, ix = this.indices;
    const pos = new Float32Array(ix.length * 3);
    const nrm = new Float32Array(ix.length * 3);
    for (let t = 0, o = 0; t < ix.length; t += 3, o += 9) {
      const a = ix[t] * 3, b = ix[t + 1] * 3, c = ix[t + 2] * 3;
      const ax = p[a], ay = p[a + 1], az = p[a + 2];
      const bx = p[b], by = p[b + 1], bz = p[b + 2];
      const cx = p[c], cy = p[c + 1], cz = p[c + 2];
      pos[o] = ax; pos[o + 1] = ay; pos[o + 2] = az;
      pos[o + 3] = bx; pos[o + 4] = by; pos[o + 5] = bz;
      pos[o + 6] = cx; pos[o + 7] = cy; pos[o + 8] = cz;
      const ux = bx - ax, uy = by - ay, uz = bz - az;
      const vx = cx - ax, vy = cy - ay, vz = cz - az;
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const len = Math.hypot(nx, ny, nz) || 1;
      nx /= len; ny /= len; nz /= len;
      for (let k = 0; k < 9; k += 3) { nrm[o + k] = nx; nrm[o + k + 1] = ny; nrm[o + k + 2] = nz; }
    }
    return { position: pos, normal: nrm };
  }
}

/** Pack an undirected edge into one number. Safe while vertexCount < 2^26 (67M). */
export const EDGE_SHIFT = 67108864; // 2^26
export function edgeKey(a, b) {
  return a < b ? a * EDGE_SHIFT + b : b * EDGE_SHIFT + a;
}
export function edgeFrom(key) {
  const a = Math.floor(key / EDGE_SHIFT);
  return [a, key - a * EDGE_SHIFT];
}
