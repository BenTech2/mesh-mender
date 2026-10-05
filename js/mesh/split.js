/**
 * Cutting a model in two with a plane.
 *
 * The cut itself is simple — clip every triangle against the half-space — and
 * the work is all in closing the wound. A cut surface has to be capped, or both
 * halves come back as open shells that no slicer will fill, and the cap cannot
 * just be a disc: cut a hollow tube and the right answer is a ring. So the cut
 * outline is assembled into loops, the loops are sorted into outlines and the
 * holes inside them, and each outline is triangulated with its holes bridged in.
 */
import { Mesh } from './core.js';
import { buildEdgeTable, boundaryLoops, classifyEdges } from './topology.js';
import { weldVertices } from './cleanup.js';

/** Builds one side of the cut, sharing vertices so the halves stay welded. */
class HalfBuilder {
  constructor(source) {
    this.source = source;
    this.positions = [];
    this.fromOriginal = new Map();
    this.fromCut = new Map();
    this.indices = [];
  }

  original(index) {
    let mapped = this.fromOriginal.get(index);
    if (mapped === undefined) {
      mapped = this.positions.length / 3;
      this.positions.push(
        this.source[index * 3], this.source[index * 3 + 1], this.source[index * 3 + 2],
      );
      this.fromOriginal.set(index, mapped);
    }
    return mapped;
  }

  /**
   * A point partway along an edge. Keyed on the edge so neighbouring triangles
   * land on the same vertex — otherwise the cut outline comes apart into
   * thousands of unjoined segments and nothing can be capped.
   */
  onEdge(a, b, t, axis, position) {
    const lo = Math.min(a, b), hi = Math.max(a, b);
    const key = lo * 16777216 + hi;
    let mapped = this.fromCut.get(key);
    if (mapped !== undefined) return mapped;

    // Always interpolate from the lower index, so both halves compute bit-identical points.
    const ratio = lo === a ? t : 1 - t;
    mapped = this.positions.length / 3;
    for (let k = 0; k < 3; k++) {
      const value = this.source[lo * 3 + k] + (this.source[hi * 3 + k] - this.source[lo * 3 + k]) * ratio;
      this.positions.push(k === axis ? position : value);
    }
    this.fromCut.set(key, mapped);
    return mapped;
  }

  triangle(i, j, k) {
    if (i === j || j === k || i === k) return;
    this.indices.push(i, j, k);
  }

  build(name, unit) {
    const mesh = new Mesh(new Float64Array(this.positions), new Uint32Array(this.indices));
    mesh.name = name;
    mesh.unit = unit;
    return mesh;
  }
}

/** Ray-casting containment test for a point against a 2D polygon. */
function pointInPolygon(point, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i], b = polygon[j];
    if ((a[1] > point[1]) !== (b[1] > point[1])
      && point[0] < ((b[0] - a[0]) * (point[1] - a[1])) / (b[1] - a[1]) + a[0]) {
      inside = !inside;
    }
  }
  return inside;
}

function signedArea(polygon) {
  let area = 0;
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i], b = polygon[(i + 1) % polygon.length];
    area += a[0] * b[1] - b[0] * a[1];
  }
  return area / 2;
}

function segmentsProperlyCross(a, b, c, d) {
  const sign = (p, q, r) => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
  const d1 = sign(a, b, c), d2 = sign(a, b, d), d3 = sign(c, d, a), d4 = sign(c, d, b);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

/**
 * Join each hole to its surrounding outline with a bridge, producing one simple
 * polygon that ordinary ear clipping can handle.
 *
 * The bridge is the shortest pair of vertices that can see each other without
 * the segment crossing any edge of any loop. Brute force over the candidates:
 * cut cross-sections are small, and a correct bridge matters more here than a
 * clever one.
 */
function bridgeHoles(outer, holes) {
  let polygon = outer.slice();
  const remaining = holes.slice();

  while (remaining.length) {
    let bestHole = -1, bestOuter = -1, bestInner = -1, bestDistance = Infinity;

    for (let h = 0; h < remaining.length; h++) {
      const hole = remaining[h];
      for (let i = 0; i < hole.length; i++) {
        for (let j = 0; j < polygon.length; j++) {
          const dx = hole[i][0] - polygon[j][0], dy = hole[i][1] - polygon[j][1];
          const distance = dx * dx + dy * dy;
          if (distance >= bestDistance) continue;

          let blocked = false;
          for (const loop of [polygon, ...remaining]) {
            for (let e = 0; e < loop.length && !blocked; e++) {
              const a = loop[e], b = loop[(e + 1) % loop.length];
              if (a === hole[i] || b === hole[i] || a === polygon[j] || b === polygon[j]) continue;
              if (segmentsProperlyCross(hole[i], polygon[j], a, b)) blocked = true;
            }
            if (blocked) break;
          }
          if (blocked) continue;

          bestDistance = distance; bestHole = h; bestOuter = j; bestInner = i;
        }
      }
    }

    if (bestHole < 0) break; // no visible bridge: leave the rest uncapped rather than guess
    const hole = remaining.splice(bestHole, 1)[0];
    const woven = [];
    for (let i = 0; i <= bestOuter; i++) woven.push(polygon[i]);
    for (let i = 0; i <= hole.length; i++) woven.push(hole[(bestInner + i) % hole.length]);
    for (let i = bestOuter; i < polygon.length; i++) woven.push(polygon[i]);
    polygon = woven;
  }
  return polygon;
}

/**
 * Ear clipping for a simple anticlockwise polygon. Returns index triples.
 *
 * Bridging leaves the polygon with pairs of vertices sitting on exactly the
 * same point — that is what a bridge is. A naive containment test reads such a
 * twin as lying inside every candidate ear, so no ear ever qualifies, and
 * whatever the fallback then emits overlaps its neighbours and leaves an edge
 * shared by four faces. Coincident points are therefore skipped when deciding
 * whether an ear is clear.
 */
function earClip(polygon) {
  const n = polygon.length;
  const triangles = [];
  if (n < 3) return triangles;

  let scale = 0;
  for (const point of polygon) scale = Math.max(scale, Math.abs(point[0]), Math.abs(point[1]));
  const eps = Math.max(scale, 1) * 1e-12;

  const area2 = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const same = (a, b) => Math.abs(a[0] - b[0]) <= eps && Math.abs(a[1] - b[1]) <= eps;

  const remaining = polygon.map((_, i) => i);
  let guard = n * n + 64;

  while (remaining.length > 3 && guard-- > 0) {
    let cut = -1;
    for (let i = 0; i < remaining.length; i++) {
      const prev = remaining[(i - 1 + remaining.length) % remaining.length];
      const curr = remaining[i];
      const next = remaining[(i + 1) % remaining.length];
      const a = polygon[prev], b = polygon[curr], c = polygon[next];
      if (area2(a, b, c) <= eps) continue; // reflex, flat, or a bridge doubling back

      let blocked = false;
      for (const other of remaining) {
        if (other === prev || other === curr || other === next) continue;
        const q = polygon[other];
        // A bridge's twin shares its position with one of the corners; it is
        // the same point, not an obstacle inside the ear.
        if (same(q, a) || same(q, b) || same(q, c)) continue;
        if (area2(a, b, q) >= 0 && area2(b, c, q) >= 0 && area2(c, a, q) >= 0) { blocked = true; break; }
      }
      if (blocked) continue;

      triangles.push([prev, curr, next]);
      remaining.splice(i, 1);
      cut = i;
      break;
    }
    if (cut >= 0) continue;

    // No ear available. Drop a vertex that contributes no area — a collinear
    // point or a bridge twin — without emitting anything, rather than forcing
    // out a triangle that would overlap its neighbours.
    let flattest = -1, flattestArea = Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const a = polygon[remaining[(i - 1 + remaining.length) % remaining.length]];
      const b = polygon[remaining[i]];
      const c = polygon[remaining[(i + 1) % remaining.length]];
      const value = Math.abs(area2(a, b, c));
      if (value < flattestArea) { flattestArea = value; flattest = i; }
    }
    if (flattest < 0) break;
    remaining.splice(flattest, 1);
  }

  if (remaining.length === 3) triangles.push([remaining[0], remaining[1], remaining[2]]);
  return triangles;
}

/**
 * Close the cut face of one half.
 *
 * @param {Mesh} half
 * @param {number} axis
 * @param {number} position
 * @param {number} facing +1 if the cap's normal should point along the axis
 * @param {number} eps
 */
function capCut(half, axis, position, facing, eps) {
  const edges = buildEdgeTable(half);
  const loops = boundaryLoops(half, edges);
  if (loops.length === 0) return { triangles: 0, area: 0, loops: 0 };

  const u = (axis + 1) % 3, v = (axis + 2) % 3;
  const p = half.positions;
  const onPlane = (index) => Math.abs(p[index * 3 + axis] - position) <= eps * 4;

  const planar = loops.filter((loop) => loop.every(onPlane));
  if (planar.length === 0) return { triangles: 0, area: 0, loops: 0 };

  // Flatten each loop into the cutting plane, remembering which mesh vertex
  // each 2D point came from.
  const rings = planar.map((loop) => {
    const ring = loop.map((index) => {
      const point = [p[index * 3 + u], p[index * 3 + v]];
      point.vertex = index;
      return point;
    });
    // Anticlockwise in (u, v) is a normal along +axis, by the right-hand rule.
    if (signedArea(ring) < 0) ring.reverse();
    return ring;
  });

  // An outline contains an odd number of other loops around it; a hole is
  // contained by an odd number. Even depth is solid, odd is a void.
  const depth = rings.map((ring, i) => {
    let count = 0;
    for (let j = 0; j < rings.length; j++) {
      if (i !== j && pointInPolygon(ring[0], rings[j])) count++;
    }
    return count;
  });

  const added = [];
  let capArea = 0;
  for (let i = 0; i < rings.length; i++) {
    if (depth[i] % 2 !== 0) continue; // this one is a hole in something else

    const holes = [];
    for (let j = 0; j < rings.length; j++) {
      if (j === i || depth[j] !== depth[i] + 1) continue;
      if (!pointInPolygon(rings[j][0], rings[i])) continue;
      const hole = rings[j].slice();
      hole.reverse(); // holes run the other way round
      holes.push(hole);
    }

    const polygon = holes.length ? bridgeHoles(rings[i], holes) : rings[i];
    const triangles = earClip(polygon);
    capArea += Math.abs(signedArea(rings[i]));
    for (const hole of holes) capArea -= Math.abs(signedArea(hole));

    for (const [a, b, c] of triangles) {
      const va = polygon[a].vertex, vb = polygon[b].vertex, vc = polygon[c].vertex;
      if (va === vb || vb === vc || va === vc) continue;
      // The polygon is anticlockwise, so this winding faces +axis; reverse it
      // for the half that needs the cap looking the other way.
      if (facing > 0) added.push(va, vb, vc);
      else added.push(va, vc, vb);
    }
  }

  if (added.length === 0) return { triangles: 0, area: 0, loops: planar.length };
  const indices = new Uint32Array(half.indices.length + added.length);
  indices.set(half.indices);
  indices.set(added, half.indices.length);
  half.indices = indices;
  return { triangles: added.length / 3, area: capArea, loops: planar.length };
}

/**
 * Cut a mesh in two with a plane perpendicular to one axis.
 *
 * @param {Mesh} mesh
 * @param {0|1|2} axis
 * @param {number} position coordinate of the plane along that axis
 * @param {{cap?: boolean, tolerance?: number}} opts
 */
export function splitByPlane(mesh, axis, position, opts = {}) {
  const cap = opts.cap !== false;
  const eps = opts.tolerance ?? Math.max(mesh.bounds().diagonal * 1e-9, 1e-12);

  // Welding first, for the same reason the voxel rebuild needs it: an STL
  // arrives as loose triangles sharing no vertices, so the cut produces loose
  // segments rather than a closed outline, and there is nothing to cap.
  const source = weldVertices(mesh, opts.weldTolerance ?? mesh.defaultEpsilon()).mesh;

  const p = source.positions, ix = source.indices;
  const nv = source.vertexCount;
  const distance = new Float64Array(nv);
  const side = new Int8Array(nv);
  for (let i = 0; i < nv; i++) {
    const d = p[i * 3 + axis] - position;
    distance[i] = d;
    side[i] = d < -eps ? -1 : d > eps ? 1 : 0;
  }

  const below = new HalfBuilder(p);
  const above = new HalfBuilder(p);

  // Sutherland-Hodgman against each half-space, which covers every way a
  // triangle can meet the plane without a case analysis per configuration.
  const clip = (corners, keepBelow, builder) => {
    const out = [];
    for (let i = 0; i < corners.length; i++) {
      const current = corners[i], next = corners[(i + 1) % corners.length];
      const sCurrent = side[current], sNext = side[next];
      const keepCurrent = keepBelow ? sCurrent <= 0 : sCurrent >= 0;
      if (keepCurrent) out.push(builder.original(current));
      if (sCurrent * sNext < 0) {
        const t = distance[current] / (distance[current] - distance[next]);
        out.push(builder.onEdge(current, next, t, axis, position));
      }
    }
    for (let i = 1; i + 1 < out.length; i++) builder.triangle(out[0], out[i], out[i + 1]);
  };

  for (let t = 0; t < ix.length; t += 3) {
    const corners = [ix[t], ix[t + 1], ix[t + 2]];
    const s0 = side[corners[0]], s1 = side[corners[1]], s2 = side[corners[2]];

    if (s0 === 0 && s1 === 0 && s2 === 0) {
      // Lying in the plane: give it to the side whose solid it bounds.
      const a = corners[0] * 3, b = corners[1] * 3, c = corners[2] * 3;
      const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
      const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
      const n = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
      const builder = n[axis] >= 0 ? below : above;
      clip(corners, builder === below, builder);
      continue;
    }
    if (s0 <= 0 && s1 <= 0 && s2 <= 0) { clip(corners, true, below); continue; }
    if (s0 >= 0 && s1 >= 0 && s2 >= 0) { clip(corners, false, above); continue; }
    clip(corners, true, below);
    clip(corners, false, above);
  }

  const belowMesh = below.build(`${mesh.name || 'model'} (lower)`, mesh.unit);
  const aboveMesh = above.build(`${mesh.name || 'model'} (upper)`, mesh.unit);

  const caps = { below: null, above: null };
  if (cap) {
    // The lower half's new face looks up the axis; the upper half's looks down.
    if (belowMesh.triangleCount) caps.below = capCut(belowMesh, axis, position, +1, eps);
    if (aboveMesh.triangleCount) caps.above = capCut(aboveMesh, axis, position, -1, eps);
  }

  // Say so when a cap could not be closed. A cut through a model whose walls
  // already pass through each other has no single cross-section outline to
  // follow, and silently handing back an open shell would be worse than
  // admitting it.
  const openEdges = (half) =>
    half.triangleCount ? classifyEdges(buildEdgeTable(half)).boundary : 0;
  const leftOpen = openEdges(belowMesh) + openEdges(aboveMesh);

  return {
    below: belowMesh,
    above: aboveMesh,
    caps,
    leftOpen,
    crossSectionArea: caps.below?.area ?? caps.above?.area ?? 0,
    axis,
    position,
  };
}

export const AXIS_NAMES = ['X', 'Y', 'Z'];
