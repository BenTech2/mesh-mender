/**
 * Bounding-volume hierarchy over triangles.
 *
 * Built once and reused for self-intersection search and ray queries. Median
 * split on the longest axis of the centroid spread: not the best possible tree,
 * but it builds in a fraction of the time a full SAH sweep takes, and this is
 * running in a worker while someone waits.
 */
const LEAF_SIZE = 8;

export class TriangleBVH {
  constructor(mesh) {
    const nf = mesh.triangleCount;
    this.mesh = mesh;
    this.order = new Uint32Array(nf);
    for (let i = 0; i < nf; i++) this.order[i] = i;

    this.triMin = new Float64Array(nf * 3);
    this.triMax = new Float64Array(nf * 3);
    const p = mesh.positions, ix = mesh.indices;
    for (let f = 0; f < nf; f++) {
      const t = f * 3;
      const a = ix[t] * 3, b = ix[t + 1] * 3, c = ix[t + 2] * 3;
      for (let k = 0; k < 3; k++) {
        this.triMin[f * 3 + k] = Math.min(p[a + k], p[b + k], p[c + k]);
        this.triMax[f * 3 + k] = Math.max(p[a + k], p[b + k], p[c + k]);
      }
    }

    // Upper bound on node count for a binary tree over ceil(nf / LEAF_SIZE) leaves.
    const maxNodes = Math.max(1, 2 * Math.ceil(nf / LEAF_SIZE) + 1) * 2;
    this.min = new Float64Array(maxNodes * 3);
    this.max = new Float64Array(maxNodes * 3);
    this.left = new Int32Array(maxNodes).fill(-1);
    this.right = new Int32Array(maxNodes).fill(-1);
    this.start = new Int32Array(maxNodes);
    this.count = new Int32Array(maxNodes);
    this.nodeCount = 0;
    if (nf > 0) this.root = this.build(0, nf);
    else this.root = -1;
  }

  build(start, count) {
    const node = this.nodeCount++;
    const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    for (let i = start; i < start + count; i++) {
      const f = this.order[i];
      for (let k = 0; k < 3; k++) {
        if (this.triMin[f * 3 + k] < mn[k]) mn[k] = this.triMin[f * 3 + k];
        if (this.triMax[f * 3 + k] > mx[k]) mx[k] = this.triMax[f * 3 + k];
      }
    }
    for (let k = 0; k < 3; k++) { this.min[node * 3 + k] = mn[k]; this.max[node * 3 + k] = mx[k]; }
    this.start[node] = start;
    this.count[node] = count;

    if (count <= LEAF_SIZE) return node;

    let axis = 0, best = -Infinity;
    for (let k = 0; k < 3; k++) {
      const span = mx[k] - mn[k];
      if (span > best) { best = span; axis = k; }
    }
    if (!(best > 0)) return node; // all boxes coincide: keep as a leaf

    const centre = (f) => (this.triMin[f * 3 + axis] + this.triMax[f * 3 + axis]) / 2;
    const slice = Array.prototype.slice.call(this.order, start, start + count);
    slice.sort((a, b) => centre(a) - centre(b));
    for (let i = 0; i < count; i++) this.order[start + i] = slice[i];

    const mid = count >> 1;
    this.count[node] = 0; // internal
    this.left[node] = this.build(start, mid);
    this.right[node] = this.build(start + mid, count - mid);
    return node;
  }

  nodeOverlaps(node, mn, mx) {
    const i = node * 3;
    return !(this.max[i] < mn[0] || this.min[i] > mx[0] ||
             this.max[i + 1] < mn[1] || this.min[i + 1] > mx[1] ||
             this.max[i + 2] < mn[2] || this.min[i + 2] > mx[2]);
  }

  /** Call `visit(face)` for every triangle whose box overlaps the given box. */
  queryBox(mn, mx, visit) {
    if (this.root < 0) return;
    const stack = [this.root];
    while (stack.length) {
      const n = stack.pop();
      if (!this.nodeOverlaps(n, mn, mx)) continue;
      if (this.count[n] > 0) {
        for (let i = this.start[n]; i < this.start[n] + this.count[n]; i++) {
          if (visit(this.order[i]) === false) return;
        }
      } else {
        if (this.left[n] >= 0) stack.push(this.left[n]);
        if (this.right[n] >= 0) stack.push(this.right[n]);
      }
    }
  }

  faceBox(f, mn, mx) {
    for (let k = 0; k < 3; k++) { mn[k] = this.triMin[f * 3 + k]; mx[k] = this.triMax[f * 3 + k]; }
  }
}
