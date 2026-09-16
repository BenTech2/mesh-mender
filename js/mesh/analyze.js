/**
 * The diagnosis. Everything here is read-only: it tells you what is wrong and
 * how bad it is, and changes nothing.
 */
import { buildEdgeTable, classifyEdges, faceComponents, boundaryLoops,
         nonManifoldVertices, unusedVertexCount } from './topology.js';
import { shellInfo } from './shells.js';
import { findSelfIntersections, classifyIntersections } from './intersect.js';

/** Math.max(...array) throws on big arrays; meshes routinely produce big arrays. */
function maxOf(list, pick) {
  let best = 0;
  for (const item of list) {
    const value = pick(item);
    if (value > best) best = value;
  }
  return best;
}

function countDegenerate(mesh, areaEps) {
  const ix = mesh.indices;
  let repeated = 0, slivers = 0;
  for (let f = 0, t = 0; t < ix.length; f++, t += 3) {
    const a = ix[t], b = ix[t + 1], c = ix[t + 2];
    if (a === b || b === c || a === c) { repeated++; continue; }
    if (areaEps > 0 && mesh.triangleArea(f) <= areaEps) slivers++;
  }
  return { repeated, slivers, total: repeated + slivers };
}

function countDuplicates(mesh) {
  const ix = mesh.indices;
  const groups = new Map();
  for (let f = 0, t = 0; t < ix.length; f++, t += 3) {
    let a = ix[t], b = ix[t + 1], c = ix[t + 2];
    let parity = 0;
    if (a > b) { const s = a; a = b; b = s; parity ^= 1; }
    if (b > c) { const s = b; b = c; c = s; parity ^= 1; }
    if (a > b) { const s = a; a = b; b = s; parity ^= 1; }
    const key = a + '_' + b + '_' + c;
    const g = groups.get(key);
    if (g) { g[parity]++; } else { const n = [0, 0]; n[parity] = 1; groups.set(key, n); }
  }
  let identical = 0, opposite = 0;
  for (const [even, odd] of groups.values()) {
    if (even > 1) identical += even - 1;
    if (odd > 1) identical += odd - 1;
    if (even && odd) opposite += 2;
  }
  return { identical, opposite, total: identical + opposite };
}

/** Vertices sitting on top of each other — the classic un-welded STL. */
function countCoincidentVertices(mesh, eps) {
  const p = mesh.positions;
  const nv = mesh.vertexCount;
  if (nv === 0 || !(eps > 0)) return 0;
  const inv = 1 / eps;
  const buckets = new Map();
  const hash = (x, y, z) =>
    (Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791)) >>> 0;
  let duplicates = 0;
  const eps2 = eps * eps;
  const reps = [];
  for (let v = 0; v < nv; v++) {
    const i = v * 3;
    const x = p[i], y = p[i + 1], z = p[i + 2];
    const cx = Math.floor(x * inv), cy = Math.floor(y * inv), cz = Math.floor(z * inv);
    let found = false;
    outer:
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      const list = buckets.get(hash(cx + dx, cy + dy, cz + dz));
      if (!list) continue;
      for (const id of list) {
        const j = reps[id] * 3;
        const ddx = p[j] - x, ddy = p[j + 1] - y, ddz = p[j + 2] - z;
        if (ddx * ddx + ddy * ddy + ddz * ddz <= eps2) { found = true; break outer; }
      }
    }
    if (found) { duplicates++; continue; }
    const id = reps.length;
    reps.push(v);
    const h = hash(cx, cy, cz);
    const list = buckets.get(h);
    if (list) list.push(id); else buckets.set(h, [id]);
  }
  return duplicates;
}

/**
 * @param {import('./core.js').Mesh} mesh
 * @param {{tolerance?: number, checkSelfIntersections?: boolean, maxPairs?: number}} opts
 */
export function analyze(mesh, opts = {}) {
  const bounds = mesh.bounds();
  const tolerance = opts.tolerance ?? mesh.defaultEpsilon();
  const areaEps = tolerance * tolerance;

  const edges = buildEdgeTable(mesh);
  const edgeStats = classifyEdges(edges);
  const comps = faceComponents(mesh, edges);
  const loops = boundaryLoops(mesh, edges);
  const nmv = nonManifoldVertices(mesh, edges);
  const degenerate = countDegenerate(mesh, areaEps);
  const duplicates = countDuplicates(mesh);
  const shells = shellInfo(mesh, edges).shells;

  let selfIntersections = null;
  if (opts.checkSelfIntersections) {
    const si = findSelfIntersections(mesh, { maxPairs: opts.maxPairs ?? 50000, tolerance });
    const split = classifyIntersections(mesh, si.pairs, comps.comp);
    selfIntersections = {
      count: si.count,
      faces: si.faces.size,
      truncated: si.truncated,
      within: split.within.length / 2,
      between: split.between.length / 2,
    };
  }

  const watertight = edgeStats.boundary === 0;
  const manifold = edgeStats.nonManifold === 0 && nmv.length === 0;
  const oriented = edgeStats.inconsistent === 0;
  const volume = mesh.signedVolume();

  const V = mesh.vertexCount - unusedVertexCount(mesh);
  const E = edges.count;
  const F = mesh.triangleCount;
  const euler = V - E + F;
  const genus = (watertight && manifold && oriented && comps.count > 0)
    ? (2 * comps.count - euler) / 2
    : null;

  const coincident = countCoincidentVertices(mesh, tolerance);
  // An STL stores every triangle's corners separately, so a file that has never
  // been welded arrives as thousands of disconnected triangles. Counting those
  // as "holes" is true and useless — the number means nothing until the mesh
  // has a topology at all, and leading with it buries the one fact that does
  // matter.
  const unwelded = coincident > 0 && edgeStats.boundary > 0
    && coincident > mesh.vertexCount * 0.25;

  const problems = [];
  if (unwelded) {
    problems.push({
      id: 'coincident-vertices',
      severity: 'critical',
      label: 'The mesh has never been welded',
      detail: `${coincident} of ${mesh.vertexCount} vertices are duplicates sitting exactly on top of another. Until they are merged the triangles are not joined to each other, so the hole and body counts below are not meaningful. Welding is the first thing repair does.`,
    });
  }
  if (!watertight) {
    problems.push({
      id: 'holes',
      severity: unwelded ? 'warning' : 'critical',
      label: loops.length === 1 ? '1 hole in the surface' : `${loops.length} holes in the surface`,
      detail: unwelded
        ? `${edgeStats.boundary} open edges — but nearly all of them are seams between triangles that welding will join. Expect this to collapse to a handful.`
        : `${edgeStats.boundary} open edge${edgeStats.boundary === 1 ? '' : 's'}. The model has no definite inside, so a slicer cannot tell what to fill.`,
    });
  }
  if (edgeStats.nonManifold > 0) {
    problems.push({
      id: 'nonmanifold-edges',
      severity: 'critical',
      label: `${edgeStats.nonManifold} edge${edgeStats.nonManifold === 1 ? '' : 's'} shared by more than two faces`,
      detail: 'More than two walls meet along the same edge, so the solid side is ambiguous.',
    });
  }
  if (nmv.length > 0) {
    problems.push({
      id: 'nonmanifold-vertices',
      severity: 'critical',
      label: `${nmv.length} pinched ${nmv.length === 1 ? 'vertex' : 'vertices'}`,
      detail: 'The surface touches itself at a single point, with no thickness there to print.',
    });
  }
  if (!oriented) {
    problems.push({
      id: 'winding',
      severity: 'critical',
      label: `${edgeStats.inconsistent} edge${edgeStats.inconsistent === 1 ? '' : 's'} where neighbouring faces disagree on which side is out`,
      detail: 'Inverted faces; usually shows up as dark or missing patches in the slicer preview.',
    });
  }
  if (watertight && manifold && oriented && volume < 0) {
    problems.push({
      id: 'inverted',
      severity: 'critical',
      label: 'The whole model is inside-out',
      detail: 'Consistently wound, but every normal points inwards, so the solid is everything except the object.',
    });
  }
  if (degenerate.total > 0) {
    problems.push({
      id: 'degenerate',
      severity: 'warning',
      label: `${degenerate.total} zero-area triangle${degenerate.total === 1 ? '' : 's'}`,
      detail: 'Triangles with no area at all. Harmless to look at, a common cause of slicer crashes.',
    });
  }
  if (duplicates.total > 0) {
    problems.push({
      id: 'duplicates',
      severity: 'warning',
      label: `${duplicates.total} duplicate triangle${duplicates.total === 1 ? '' : 's'}`,
      detail: duplicates.opposite
        ? `Includes ${duplicates.opposite} back-to-back faces forming zero-thickness fins.`
        : 'The same face stored more than once.',
    });
  }
  if (comps.count > 1) {
    problems.push({
      id: 'shells',
      severity: 'info',
      label: `${comps.count} separate bodies`,
      detail: unwelded
        ? 'Counted before welding, so this is really the number of loose triangles. It will drop once they are joined.'
        : 'Not automatically wrong, but stray fragments print as specks of plastic.',
    });
  }
  if (selfIntersections && selfIntersections.within > 0) {
    const n = selfIntersections.within;
    problems.push({
      id: 'self-intersections',
      severity: 'warning',
      label: `${n}${selfIntersections.truncated ? '+' : ''} ${n === 1 ? 'place' : 'places'} where a body passes through itself`,
      detail: 'The surface folds through its own wall, so there is no single answer to what is inside. The model can be watertight and still slice wrongly.',
    });
  }
  if (selfIntersections && selfIntersections.between > 0) {
    const n = selfIntersections.between;
    problems.push({
      id: 'overlapping-bodies',
      severity: 'info',
      label: `${n}${selfIntersections.truncated ? '+' : ''} overlapping triangle ${n === 1 ? 'pair' : 'pairs'} between separate bodies`,
      detail: 'Two bodies share space. Most slicers merge overlapping solids and print this correctly, but the volume below counts the shared region twice.',
    });
  }

  const unused = unusedVertexCount(mesh);
  if (unused > 0) {
    problems.push({
      id: 'unused-vertices',
      severity: 'info',
      label: `${unused} unused vertices`,
      detail: 'Vertices no triangle refers to. Only wasted file size.',
    });
  }

  if (coincident > 0 && edgeStats.boundary > 0 && !unwelded) {
    problems.push({
      id: 'coincident-vertices',
      severity: 'warning',
      label: `${coincident} duplicated vertices at the same position`,
      detail: 'Triangles that look joined but are not. Welding them usually closes most of the open edges at once.',
    });
  }

  return {
    vertices: mesh.vertexCount,
    triangles: mesh.triangleCount,
    shellCount: comps.count,
    shells: shells.map((s) => ({
      index: s.index, triangleCount: s.triangleCount, volume: s.volume,
      area: s.area, closed: s.closed, openEdges: s.openEdges, size: s.size, diagonal: s.diagonal,
    })),
    edges: edges.count,
    boundaryEdges: edgeStats.boundary,
    manifoldEdges: edgeStats.manifold,
    nonManifoldEdges: edgeStats.nonManifold,
    inconsistentEdges: edgeStats.inconsistent,
    nonManifoldVertices: nmv.length,
    holes: loops.length,
    holeSizes: loops.map((l) => l.length).sort((a, b) => b - a).slice(0, 20),
    largestHole: maxOf(loops, (l) => l.length),
    degenerate,
    duplicates,
    coincidentVertices: coincident,
    unusedVertices: unused,
    selfIntersections,
    watertight, manifold, oriented,
    volume,
    area: mesh.surfaceArea(),
    bounds,
    euler,
    genus,
    tolerance,
    problems,
    // Bodies that merely overlap are left out of this: slicers union them, and
    // failing a model for it would be crying wolf.
    printable: watertight && manifold && oriented && volume > 0 &&
               degenerate.total === 0 && (!selfIntersections || selfIntersections.within === 0),
  };
}

/** Faces and edges worth drawing in red, for the viewer's highlight modes. */
export function collectHighlights(mesh, opts = {}) {
  const tolerance = opts.tolerance ?? mesh.defaultEpsilon();
  const edges = buildEdgeTable(mesh);
  const stats = classifyEdges(edges);
  const result = { boundaryEdges: [], nonManifoldEdges: [], flippedFaces: [], intersectingFaces: [] };

  for (const e of stats.boundaryEdges) result.boundaryEdges.push(edges.a[e], edges.b[e]);
  for (const e of stats.nonManifoldEdges) result.nonManifoldEdges.push(edges.a[e], edges.b[e]);

  // A face is "suspect" when any of its edges has neighbours that disagree.
  const bad = new Set();
  for (let e = 0; e < edges.count; e++) {
    const u = edges.uses[e];
    if (u.length === 2 && (u[0] & 1) === (u[1] & 1)) { bad.add(u[0] >> 1); bad.add(u[1] >> 1); }
  }
  result.flippedFaces = Array.from(bad);

  if (opts.selfIntersections) {
    const si = findSelfIntersections(mesh, { maxPairs: opts.maxPairs ?? 50000, tolerance });
    result.intersectingFaces = Array.from(si.faces);
  }
  return result;
}
