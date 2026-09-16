/**
 * Non-manifold repair.
 *
 * A vertex is non-manifold when the faces around it form more than one fan —
 * two lumps pinched together at a point, or several sheets meeting along one
 * edge. A slicer cannot decide what is solid there.
 *
 * The fix is to pull the fans apart, giving each its own copy of the vertex.
 * This also resolves non-manifold *edges* as a side effect: faces meeting on an
 * over-used edge are, by definition, not joined through it, so they land in
 * different fans and end up with separate copies of both endpoints. The edge
 * that three faces fought over becomes three ordinary open edges, which the
 * hole-filling stage then closes.
 */
import { Mesh, edgeKey } from './core.js';
import { vertexFaceAdjacency } from './topology.js';

export function splitNonManifoldVertices(mesh, edges) {
  const adj = vertexFaceAdjacency(mesh);
  const ix = mesh.indices.slice();
  const nv = mesh.vertexCount;
  const extra = [];
  let verticesSplit = 0;
  let copiesMade = 0;

  const slot = new Map();
  for (let v = 0; v < nv; v++) {
    const start = adj.offsets[v], end = adj.offsets[v + 1];
    const n = end - start;
    if (n < 2) continue;

    slot.clear();
    for (let i = start; i < end; i++) slot.set(adj.faces[i], i - start);

    const parent = new Int32Array(n);
    for (let i = 0; i < n; i++) parent[i] = i;
    const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };

    for (let i = start; i < end; i++) {
      const f = adj.faces[i], t = f * 3;
      const v0 = ix[t], v1 = ix[t + 1], v2 = ix[t + 2];
      const others = v0 === v ? [v1, v2] : v1 === v ? [v2, v0] : [v0, v1];
      for (const o of others) {
        if (o === v) continue;
        const e = edges.map.get(edgeKey(v, o));
        if (e === undefined) continue;
        const uses = edges.uses[e];
        if (uses.length !== 2) continue;
        const g0 = slot.get(uses[0] >> 1), g1 = slot.get(uses[1] >> 1);
        if (g0 === undefined || g1 === undefined) continue;
        const r0 = find(g0), r1 = find(g1);
        if (r0 !== r1) parent[r0] = r1;
      }
    }

    // Map each fan root to a vertex index: the first keeps the original.
    const rootToVertex = new Map();
    let groups = 0;
    for (let i = 0; i < n; i++) {
      const r = find(i);
      if (rootToVertex.has(r)) continue;
      groups++;
      if (groups === 1) { rootToVertex.set(r, v); continue; }
      const nvIndex = nv + extra.length / 3;
      extra.push(mesh.positions[v * 3], mesh.positions[v * 3 + 1], mesh.positions[v * 3 + 2]);
      rootToVertex.set(r, nvIndex);
      copiesMade++;
    }
    if (groups < 2) continue;
    verticesSplit++;

    for (let i = start; i < end; i++) {
      const f = adj.faces[i];
      const target = rootToVertex.get(find(i - start));
      if (target === v) continue;
      const t = f * 3;
      if (ix[t] === v) ix[t] = target;
      else if (ix[t + 1] === v) ix[t + 1] = target;
      else if (ix[t + 2] === v) ix[t + 2] = target;
    }
  }

  if (verticesSplit === 0) return { mesh, verticesSplit: 0, copiesMade: 0 };

  const positions = new Float64Array(mesh.positions.length + extra.length);
  positions.set(mesh.positions);
  positions.set(extra, mesh.positions.length);
  const out = new Mesh(positions, ix);
  out.name = mesh.name; out.unit = mesh.unit;
  return { mesh: out, verticesSplit, copiesMade };
}
