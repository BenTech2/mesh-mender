/**
 * Laying a model flat on the bed.
 *
 * The orientations a solid can rest in are the faces of its convex hull, so the
 * candidates come from there. A hull face is only a real resting position if
 * the model's centre of mass falls over the patch it would touch — otherwise it
 * topples — and the usable candidates are then ranked by how much of the model
 * ends up against the plate, because that is what decides whether a print stays
 * stuck down.
 */
import { convexHull } from './hull.js';

/**
 * Centre of mass of the enclosed solid, by summing signed tetrahedra from the
 * origin. Falls back to the area-weighted surface centre for an open mesh,
 * where "the enclosed solid" means nothing.
 */
export function volumeCentroid(mesh) {
  const p = mesh.positions, ix = mesh.indices;
  let volume = 0, cx = 0, cy = 0, cz = 0;
  for (let t = 0; t < ix.length; t += 3) {
    const a = ix[t] * 3, b = ix[t + 1] * 3, c = ix[t + 2] * 3;
    const ax = p[a], ay = p[a + 1], az = p[a + 2];
    const bx = p[b], by = p[b + 1], bz = p[b + 2];
    const cxx = p[c], cyy = p[c + 1], czz = p[c + 2];
    const v = (ax * (by * czz - bz * cyy) - ay * (bx * czz - bz * cxx) + az * (bx * cyy - by * cxx)) / 6;
    volume += v;
    cx += v * (ax + bx + cxx) / 4;
    cy += v * (ay + by + cyy) / 4;
    cz += v * (az + bz + czz) / 4;
  }
  if (Math.abs(volume) > 1e-12) return [cx / volume, cy / volume, cz / volume];

  let area = 0;
  cx = cy = cz = 0;
  for (let f = 0; f < mesh.triangleCount; f++) {
    const t = f * 3;
    const a = ix[t] * 3, b = ix[t + 1] * 3, c = ix[t + 2] * 3;
    const w = mesh.triangleArea(f);
    area += w;
    cx += w * (p[a] + p[b] + p[c]) / 3;
    cy += w * (p[a + 1] + p[b + 1] + p[c + 1]) / 3;
    cz += w * (p[a + 2] + p[b + 2] + p[c + 2]) / 3;
  }
  if (area === 0) return mesh.bounds().center;
  return [cx / area, cy / area, cz / area];
}

/** Andrew's monotone chain. Points are [x, y] pairs; returns them anticlockwise. */
export function convexHull2D(points) {
  if (points.length < 3) return points.slice();
  const sorted = points.slice().sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const build = (list) => {
    const out = [];
    for (const point of list) {
      while (out.length >= 2 && cross(out[out.length - 2], out[out.length - 1], point) <= 0) out.pop();
      out.push(point);
    }
    out.pop();
    return out;
  };
  const lower = build(sorted);
  const upper = build(sorted.reverse());
  const hull = lower.concat(upper);
  return hull.length >= 3 ? hull : points.slice();
}

function polygonArea(polygon) {
  let area = 0;
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i], b = polygon[(i + 1) % polygon.length];
    area += a[0] * b[1] - b[0] * a[1];
  }
  return Math.abs(area) / 2;
}

/** Signed distance from a point to the nearest edge; positive means inside. */
function marginInside(polygon, point) {
  if (polygon.length < 3) return -Infinity;
  let best = Infinity;
  let inside = true;
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i], b = polygon[(i + 1) % polygon.length];
    const ex = b[0] - a[0], ey = b[1] - a[1];
    const len = Math.hypot(ex, ey);
    if (len === 0) continue;
    // anticlockwise polygon: inside is to the left of every edge
    const side = ((point[0] - a[0]) * ey - (point[1] - a[1]) * ex) / len;
    if (side > 0) inside = false;
    best = Math.min(best, Math.abs(side));
  }
  return inside ? best : -best;
}

/** An orthonormal pair spanning the plane with the given normal. */
function basisFor(n) {
  const up = Math.abs(n[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  let ux = up[1] * n[2] - up[2] * n[1];
  let uy = up[2] * n[0] - up[0] * n[2];
  let uz = up[0] * n[1] - up[1] * n[0];
  const ulen = Math.hypot(ux, uy, uz) || 1;
  ux /= ulen; uy /= ulen; uz /= ulen;
  return [
    [ux, uy, uz],
    [n[1] * uz - n[2] * uy, n[2] * ux - n[0] * uz, n[0] * uy - n[1] * ux],
  ];
}

/**
 * Every orientation the model could rest in, best first.
 *
 * Coplanar hull triangles are gathered into one resting surface — a cube face
 * is two triangles but one place to put it down — and the patch that would meet
 * the bed is their combined outline.
 */
export function restingCandidates(mesh, opts = {}) {
  const hull = convexHull(mesh.positions, opts);
  if (hull.faces.length === 0) return [];

  const p = mesh.positions;
  const bounds = mesh.bounds();
  const scale = bounds.diagonal || 1;
  const centroid = volumeCentroid(mesh);

  // Group coplanar faces by rounded normal and plane offset. Rounding is
  // coarse enough to absorb the last few bits of two triangles that share a
  // face, and fine enough that a faceted curve stays a curve — which is right,
  // because a cylinder cannot rest on its side without rolling.
  const groups = new Map();
  for (const [i, j, k] of hull.faces) {
    const n = faceNormal(p, i, j, k);
    if (n === null) continue;
    const offset = n[0] * p[i * 3] + n[1] * p[i * 3 + 1] + n[2] * p[i * 3 + 2];
    const id = `${Math.round(n[0] * 100)},${Math.round(n[1] * 100)},${Math.round(n[2] * 100)},`
      + `${Math.round(offset / (scale * 1e-3))}`;
    let group = groups.get(id);
    if (!group) { group = { normal: n, vertices: new Set(), area: 0 }; groups.set(id, group); }
    group.vertices.add(i); group.vertices.add(j); group.vertices.add(k);
    group.area += triangleArea(p, i, j, k);
  }

  const candidates = [];
  for (const group of groups.values()) {
    const n = group.normal;
    const [u, v] = basisFor(n);
    const points = [];
    for (const index of group.vertices) {
      const x = p[index * 3], y = p[index * 3 + 1], z = p[index * 3 + 2];
      points.push([x * u[0] + y * u[1] + z * u[2], x * v[0] + y * v[1] + z * v[2]]);
    }
    const patch = convexHull2D(points);
    const contactArea = polygonArea(patch);
    const centre = [
      centroid[0] * u[0] + centroid[1] * u[1] + centroid[2] * u[2],
      centroid[0] * v[0] + centroid[1] * v[1] + centroid[2] * v[2],
    ];
    const margin = marginInside(patch, centre);

    // How tall the model stands once this face is down: the far side of the
    // model, measured back from the resting plane.
    const anchor = firstOf(group.vertices);
    const plane = n[0] * p[anchor * 3] + n[1] * p[anchor * 3 + 1] + n[2] * p[anchor * 3 + 2];
    let height = 0;
    for (let i = 0; i < p.length; i += 3) {
      height = Math.max(height, plane - (n[0] * p[i] + n[1] * p[i + 1] + n[2] * p[i + 2]));
    }

    candidates.push({
      height,
      normal: n,
      contactArea,
      stable: margin > 0,
      margin,
      marginRatio: margin / Math.max(Math.sqrt(contactArea), scale * 1e-6),
    });
  }

  // Stable first, then by how much of the model meets the plate.
  candidates.sort((a, b) => {
    if (a.stable !== b.stable) return a.stable ? -1 : 1;
    return b.contactArea - a.contactArea;
  });
  return candidates;
}

function firstOf(set) {
  for (const value of set) return value;
  return 0;
}

function faceNormal(p, i, j, k) {
  const ax = p[i * 3], ay = p[i * 3 + 1], az = p[i * 3 + 2];
  const ux = p[j * 3] - ax, uy = p[j * 3 + 1] - ay, uz = p[j * 3 + 2] - az;
  const vx = p[k * 3] - ax, vy = p[k * 3 + 1] - ay, vz = p[k * 3 + 2] - az;
  let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  const len = Math.hypot(nx, ny, nz);
  if (len === 0) return null;
  return [nx / len, ny / len, nz / len];
}

function triangleArea(p, i, j, k) {
  const ax = p[i * 3], ay = p[i * 3 + 1], az = p[i * 3 + 2];
  const ux = p[j * 3] - ax, uy = p[j * 3 + 1] - ay, uz = p[j * 3 + 2] - az;
  const vx = p[k * 3] - ax, vy = p[k * 3 + 1] - ay, vz = p[k * 3 + 2] - az;
  const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  return Math.hypot(nx, ny, nz) / 2;
}

/** Rotation taking unit vector `from` onto unit vector `to`, as a 3x3 row-major array. */
export function rotationBetween(from, to) {
  const dot = from[0] * to[0] + from[1] * to[1] + from[2] * to[2];
  if (dot > 1 - 1e-12) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  if (dot < -1 + 1e-12) {
    // Opposite: turn half a circle about any perpendicular axis.
    const axis = Math.abs(from[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    let ax = from[1] * axis[2] - from[2] * axis[1];
    let ay = from[2] * axis[0] - from[0] * axis[2];
    let az = from[0] * axis[1] - from[1] * axis[0];
    const len = Math.hypot(ax, ay, az) || 1;
    ax /= len; ay /= len; az /= len;
    return [
      2 * ax * ax - 1, 2 * ax * ay, 2 * ax * az,
      2 * ay * ax, 2 * ay * ay - 1, 2 * ay * az,
      2 * az * ax, 2 * az * ay, 2 * az * az - 1,
    ];
  }
  const vx = from[1] * to[2] - from[2] * to[1];
  const vy = from[2] * to[0] - from[0] * to[2];
  const vz = from[0] * to[1] - from[1] * to[0];
  const k = 1 / (1 + dot);
  return [
    vx * vx * k + dot,    vx * vy * k - vz,     vx * vz * k + vy,
    vy * vx * k + vz,     vy * vy * k + dot,    vy * vz * k - vx,
    vz * vx * k - vy,     vz * vy * k + vx,     vz * vz * k + dot,
  ];
}

/**
 * The transform that lays a model on its `index`-th best resting face and sets
 * it down on the plate.
 *
 * @returns {{matrix: number[], candidate: object, candidates: object[]} | null}
 *   `matrix` is column-major, in three.js element order.
 */
export function layFlatTransform(mesh, index = 0) {
  const candidates = restingCandidates(mesh);
  if (candidates.length === 0) return null;
  const candidate = candidates[index % candidates.length];

  // The chosen face points down once it is on the plate.
  const r = rotationBetween(candidate.normal, [0, 0, -1]);
  const pivot = mesh.bounds().center;

  // Turn about the model's own centre so it does not fly off across the bed,
  // then drop whatever is now lowest onto z = 0.
  const rotate = (x, y, z) => [
    r[0] * x + r[1] * y + r[2] * z,
    r[3] * x + r[4] * y + r[5] * z,
    r[6] * x + r[7] * y + r[8] * z,
  ];
  const p = mesh.positions;
  let lowest = Infinity;
  for (let i = 0; i < p.length; i += 3) {
    const out = rotate(p[i] - pivot[0], p[i + 1] - pivot[1], p[i + 2] - pivot[2]);
    if (out[2] < lowest) lowest = out[2];
  }

  const offset = [
    pivot[0] - (r[0] * pivot[0] + r[1] * pivot[1] + r[2] * pivot[2]),
    pivot[1] - (r[3] * pivot[0] + r[4] * pivot[1] + r[5] * pivot[2]),
    -(lowest + (r[6] * pivot[0] + r[7] * pivot[1] + r[8] * pivot[2])),
  ];

  // three.js element order: column-major.
  const matrix = [
    r[0], r[3], r[6], 0,
    r[1], r[4], r[7], 0,
    r[2], r[5], r[8], 0,
    offset[0], offset[1], offset[2], 1,
  ];
  return { matrix, candidate, candidates };
}
