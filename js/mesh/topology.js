/**
 * Topological analysis: the edge table everything else is derived from,
 * plus shells, boundary loops and non-manifold detection.
 */
import { edgeKey } from './core.js';

/**
 * Edge table.
 *
 * Each edge records the faces that use it and, for each, whether the face
 * traverses it forwards (low vertex -> high vertex) or backwards. Two faces
 * sharing an edge are consistently wound exactly when their directions differ.
 *
 * Entries are packed as `face * 2 + dir` so we can keep one flat array per edge.
 */
export function buildEdgeTable(mesh) {
  const ix = mesh.indices;
  const map = new Map();
  const ea = [];
  const eb = [];
  const uses = [];

  for (let f = 0, t = 0; t < ix.length; f++, t += 3) {
    const v0 = ix[t], v1 = ix[t + 1], v2 = ix[t + 2];
    addUse(v0, v1, f);
    addUse(v1, v2, f);
    addUse(v2, v0, f);
  }

  function addUse(a, b, f) {
    if (a === b) return; // degenerate edge, not topology
    const key = edgeKey(a, b);
    let e = map.get(key);
    if (e === undefined) {
      e = ea.length;
      map.set(key, e);
      ea.push(Math.min(a, b));
      eb.push(Math.max(a, b));
      uses.push([]);
    }
    uses[e].push(f * 2 + (a < b ? 0 : 1));
  }

  return { map, a: ea, b: eb, uses, count: ea.length };
}

export function classifyEdges(edges) {
  let boundary = 0, manifold = 0, nonManifold = 0, inconsistent = 0;
  const boundaryEdges = [];
  const nonManifoldEdges = [];
  for (let e = 0; e < edges.count; e++) {
    const u = edges.uses[e];
    if (u.length === 1) { boundary++; boundaryEdges.push(e); }
    else if (u.length === 2) {
      manifold++;
      // same direction on both sides => the two faces disagree about which way is out
      if ((u[0] & 1) === (u[1] & 1)) inconsistent++;
    } else { nonManifold++; nonManifoldEdges.push(e); }
  }
  return { boundary, manifold, nonManifold, inconsistent, boundaryEdges, nonManifoldEdges };
}

/** Faces incident to each vertex, as a CSR-style pair of arrays. */
export function vertexFaceAdjacency(mesh) {
  const ix = mesh.indices;
  const nv = mesh.vertexCount;
  const counts = new Uint32Array(nv + 1);
  for (let i = 0; i < ix.length; i++) counts[ix[i] + 1]++;
  for (let i = 0; i < nv; i++) counts[i + 1] += counts[i];
  const offsets = counts;
  const cursor = offsets.slice(0, nv);
  const faces = new Uint32Array(ix.length);
  for (let f = 0, t = 0; t < ix.length; f++, t += 3) {
    faces[cursor[ix[t]]++] = f;
    faces[cursor[ix[t + 1]]++] = f;
    faces[cursor[ix[t + 2]]++] = f;
  }
  return { offsets, faces };
}

/**
 * Connected shells, joined across manifold edges only (2 faces).
 * Splitting at non-manifold edges is deliberate: two lumps that touch along a
 * single edge are separate printable bodies, and treating them as one shell
 * makes orientation repair pick a winding that is wrong for one of them.
 */
export function faceComponents(mesh, edges) {
  const nf = mesh.triangleCount;
  const comp = new Int32Array(nf).fill(-1);
  const neighbours = faceNeighbours(mesh, edges);
  let n = 0;
  const stack = [];
  for (let f = 0; f < nf; f++) {
    if (comp[f] !== -1) continue;
    comp[f] = n;
    stack.length = 0;
    stack.push(f);
    while (stack.length) {
      const cur = stack.pop();
      const start = neighbours.offsets[cur], end = neighbours.offsets[cur + 1];
      for (let i = start; i < end; i++) {
        const nb = neighbours.faces[i];
        if (comp[nb] === -1) { comp[nb] = n; stack.push(nb); }
      }
    }
    n++;
  }
  return { comp, count: n };
}

/** Face-to-face adjacency across 2-manifold edges, CSR style. */
export function faceNeighbours(mesh, edges) {
  const nf = mesh.triangleCount;
  const counts = new Uint32Array(nf + 1);
  for (let e = 0; e < edges.count; e++) {
    const u = edges.uses[e];
    if (u.length !== 2) continue;
    counts[(u[0] >> 1) + 1]++;
    counts[(u[1] >> 1) + 1]++;
  }
  for (let i = 0; i < nf; i++) counts[i + 1] += counts[i];
  const offsets = counts;
  const cursor = offsets.slice(0, nf);
  const faces = new Uint32Array(offsets[nf]);
  for (let e = 0; e < edges.count; e++) {
    const u = edges.uses[e];
    if (u.length !== 2) continue;
    const f0 = u[0] >> 1, f1 = u[1] >> 1;
    faces[cursor[f0]++] = f1;
    faces[cursor[f1]++] = f0;
  }
  return { offsets, faces };
}

/**
 * Ordered boundary loops, wound so that a fan/patch built from a loop is
 * consistent with the faces already around the hole.
 *
 * A face on the boundary traverses its open edge u->v; the missing patch must
 * therefore traverse v->u, so we walk the reversed half-edges.
 */
export function boundaryLoops(mesh, edges) {
  const out = new Map(); // start vertex -> [end vertex, ...]
  let openCount = 0;

  for (let e = 0; e < edges.count; e++) {
    const u = edges.uses[e];
    if (u.length !== 1) continue;
    const backwards = u[0] & 1;
    const lo = edges.a[e], hi = edges.b[e];
    // direction as the face walks it
    const fromV = backwards ? hi : lo;
    const toV = backwards ? lo : hi;
    // the patch walks the other way
    let list = out.get(toV);
    if (!list) { list = []; out.set(toV, list); }
    list.push(fromV);
    openCount++;
  }

  const loops = [];
  for (const [start] of out) {
    while (true) {
      const first = out.get(start);
      if (!first || first.length === 0) break;
      const loop = [start];
      let cur = start;
      let next = first.pop();
      let guard = openCount + 4;
      while (next !== undefined && guard-- > 0) {
        if (next === start) break;
        loop.push(next);
        cur = next;
        const list = out.get(cur);
        next = list && list.length ? list.pop() : undefined;
      }
      if (next === undefined) {
        // Ran into a dead end: the boundary is not a clean cycle. Keep the
        // chain anyway — a fan across it still closes most of the gap.
        if (loop.length >= 3) loops.push(loop);
        break;
      }
      if (loop.length >= 3) loops.push(loop);
    }
  }
  return loops;
}

/**
 * Vertices where the surface pinches: the incident faces form more than one
 * fan (the classic "bowtie"). Printers and slicers cannot decide what is solid
 * at such a point, so 3D Builder-style repair splits them apart.
 */
export function nonManifoldVertices(mesh, edges, adjacency) {
  const adj = adjacency || vertexFaceAdjacency(mesh);
  const ix = mesh.indices;
  const result = [];

  // For each vertex, group its faces by shared edges that also touch the vertex.
  const faceIndexInGroup = new Map();
  for (let v = 0; v < mesh.vertexCount; v++) {
    const start = adj.offsets[v], end = adj.offsets[v + 1];
    const n = end - start;
    if (n < 2) continue;
    faceIndexInGroup.clear();
    for (let i = start; i < end; i++) faceIndexInGroup.set(adj.faces[i], i - start);

    const parent = new Int32Array(n);
    for (let i = 0; i < n; i++) parent[i] = i;
    const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
    const union = (x, y) => { const rx = find(x), ry = find(y); if (rx !== ry) parent[rx] = ry; };

    for (let i = start; i < end; i++) {
      const f = adj.faces[i], t = f * 3;
      const v0 = ix[t], v1 = ix[t + 1], v2 = ix[t + 2];
      // the two edges of f that contain v
      const others = v0 === v ? [v1, v2] : v1 === v ? [v2, v0] : [v0, v1];
      for (const o of others) {
        const e = edges.map.get(edgeKey(v, o));
        if (e === undefined) continue;
        const uses = edges.uses[e];
        if (uses.length !== 2) continue; // only walk through manifold edges
        const g0 = faceIndexInGroup.get(uses[0] >> 1);
        const g1 = faceIndexInGroup.get(uses[1] >> 1);
        if (g0 !== undefined && g1 !== undefined) union(g0, g1);
      }
    }

    let groups = 0;
    for (let i = 0; i < n; i++) if (find(i) === i) groups++;
    if (groups > 1) result.push(v);
  }
  return result;
}

/** Vertices referenced by no triangle. */
export function unusedVertexCount(mesh) {
  const used = new Uint8Array(mesh.vertexCount);
  const ix = mesh.indices;
  for (let i = 0; i < ix.length; i++) used[ix[i]] = 1;
  let n = 0;
  for (let i = 0; i < used.length; i++) if (!used[i]) n++;
  return n;
}
