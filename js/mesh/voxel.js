/**
 * Rebuilding a model as a solid.
 *
 * The surgical repairs elsewhere in this folder fix a surface by editing it.
 * Some damage does not respond to that: a wall that passes through its own
 * body, or two solids that overlap, have no local edit that makes them one
 * coherent object. 3D Builder's answer was to stop editing and re-derive the
 * surface from scratch, and that is what this does.
 *
 *   1. Decide, for every point on a regular grid, whether it is inside the
 *      solid — by firing a ray along each grid line and counting crossings.
 *   2. Extract a fresh surface along the inside/outside boundary.
 *
 * The result is watertight, manifold and free of self-intersections by
 * construction, because a surface built from an inside/outside field cannot be
 * anything else. The cost is that every detail is resampled at the grid
 * spacing, so sharp edges soften and fine features below one voxel disappear.
 * It is a sledgehammer, and it is offered as one.
 *
 * Overlapping bodies are merged rather than double-counted because the inside
 * test uses the *winding number* — the signed count of crossings — rather than
 * odd/even parity. A point inside two overlapping solids has winding 2, which
 * is still inside; parity would call it outside and punch a hole through the
 * shared region. The same property makes an inside-out shell (winding -1) come
 * out solid instead of inverted.
 */
import { Mesh } from './core.js';
import { removeDegenerateTriangles, removeUnusedVertices, collapseDegenerateEdges, weldVertices } from './cleanup.js';
import { buildEdgeTable, classifyEdges, faceComponents, nonManifoldVertices } from './topology.js';
import { splitNonManifoldVertices } from './nonmanifold.js';
import { makeNormalsOutward, applyFlips } from './orient.js';
import { removeDebrisShells } from './shells.js';

const MAX_GRID_POINTS = 48_000_000; // ~48 MB for the sign grid

/**
 * Offsets the grid off any round number, so grid lines do not land exactly on
 * geometry. Axis-aligned models — boxes above all — otherwise fire every ray
 * straight down a shared edge, where a crossing is counted twice or not at all.
 */
const JITTER = 0.0137;

/**
 * Empty grid layers around the model. Three, because the outer two get forced
 * empty to guarantee the surface closes (see `sealBoundary`) and the model
 * still needs clear air beyond its own bounding box.
 */
const PADDING = 3;

function clamp(value, low, high) {
  return Math.max(low, Math.min(high, value));
}

/**
 * Half of the top-left fill rule: does this edge own the points lying exactly
 * on it? Two triangles sharing an edge traverse it in opposite directions, so
 * exactly one of them answers yes.
 */
function topLeft(dx, dy) {
  return dy > 0 || (dy === 0 && dx < 0);
}

/**
 * Which side of an edge the ray falls on, evaluated from the edge's lower
 * vertex index regardless of which triangle is asking.
 *
 * The canonical order is the whole point. Evaluated naively, the two triangles
 * either side of an edge compute the same quantity from different base
 * vertices, and floating point does not give exactly opposite answers: one
 * reads 0 while its neighbour reads 2.8e-17. Both then believe the ray is
 * inside them, the crossing is counted twice, and everything beyond that point
 * flips to solid. Keyed on vertex index, the two results are bit-exact
 * negations, so exactly one triangle claims the ray — and when the value is
 * genuinely zero, the top-left rule breaks the tie.
 */
function edgeValue(px, py, ax, ay, bx, by, ia, ib) {
  if (ia < ib) return (bx - ax) * (py - ay) - (by - ay) * (px - ax);
  return -((ax - bx) * (py - by) - (ay - by) * (px - bx));
}

/**
 * Plan the grid: spacing, origin and dimensions, reducing the resolution if the
 * requested one would need more memory than we are willing to take.
 */
export function planGrid(mesh, opts = {}) {
  const bounds = mesh.bounds();
  const longest = Math.max(bounds.size[0], bounds.size[1], bounds.size[2]) || 1;
  const requested = clamp(Math.round(opts.resolution ?? 192), 16, 600);

  let voxel = opts.voxelSize > 0 ? opts.voxelSize : longest / requested;
  let dims, points;
  let reduced = false;

  for (let attempt = 0; attempt < 24; attempt++) {
    dims = [0, 0, 0];
    for (let a = 0; a < 3; a++) dims[a] = Math.ceil(bounds.size[a] / voxel) + PADDING * 2 + 1;
    points = dims[0] * dims[1] * dims[2];
    if (points <= MAX_GRID_POINTS) break;
    voxel *= 1.25;
    reduced = true;
  }

  const origin = [0, 0, 0];
  for (let a = 0; a < 3; a++) origin[a] = bounds.min[a] - voxel * (PADDING + JITTER);

  return { voxel, origin, dims, points, reduced, resolution: Math.round(longest / voxel) };
}

/**
 * Bucket triangles by the grid column they cover, so each ray only tests the
 * triangles that could possibly be above or below it.
 */
function bucketTriangles(mesh, grid, axis) {
  const u = (axis + 1) % 3, v = (axis + 2) % 3;
  const nu = grid.dims[u], nv = grid.dims[v];
  const buckets = new Array(nu * nv);
  const p = mesh.positions, ix = mesh.indices;

  for (let f = 0; f < mesh.triangleCount; f++) {
    const t = f * 3;
    const a = ix[t] * 3, b = ix[t + 1] * 3, c = ix[t + 2] * 3;
    const minU = Math.min(p[a + u], p[b + u], p[c + u]);
    const maxU = Math.max(p[a + u], p[b + u], p[c + u]);
    const minV = Math.min(p[a + v], p[b + v], p[c + v]);
    const maxV = Math.max(p[a + v], p[b + v], p[c + v]);

    const i0 = clamp(Math.floor((minU - grid.origin[u]) / grid.voxel), 0, nu - 1);
    const i1 = clamp(Math.ceil((maxU - grid.origin[u]) / grid.voxel), 0, nu - 1);
    const j0 = clamp(Math.floor((minV - grid.origin[v]) / grid.voxel), 0, nv - 1);
    const j1 = clamp(Math.ceil((maxV - grid.origin[v]) / grid.voxel), 0, nv - 1);

    for (let j = j0; j <= j1; j++) {
      const row = j * nu;
      for (let i = i0; i <= i1; i++) {
        const key = row + i;
        const list = buckets[key];
        if (list) list.push(f); else buckets[key] = [f];
      }
    }
  }
  return { buckets, u, v, nu, nv };
}

/**
 * Fire a ray along `axis` through every grid line, recording where it crosses
 * the surface and which way each crossing goes.
 *
 * Returns the inside/outside state of every grid point (if `signs` is given)
 * and the exact crossing position on every grid edge it passes through, so the
 * extracted surface sits on the real geometry rather than snapping to the grid.
 */
function stab(mesh, grid, axis, signs, crossings, onProgress) {
  const { buckets, u, v, nu, nv } = bucketTriangles(mesh, grid, axis);
  const p = mesh.positions, ix = mesh.indices;
  const nAxis = grid.dims[axis];
  const strideAxis = axis === 0 ? 1 : axis === 1 ? grid.dims[0] : grid.dims[0] * grid.dims[1];
  const strideU = u === 0 ? 1 : u === 1 ? grid.dims[0] : grid.dims[0] * grid.dims[1];
  const strideV = v === 0 ? 1 : v === 1 ? grid.dims[0] : grid.dims[0] * grid.dims[1];

  const hitsT = [];
  const hitsDir = [];
  const order = [];

  for (let jv = 0; jv < nv; jv++) {
    if (onProgress && (jv & 15) === 0) onProgress(jv / nv);
    const rowV = grid.origin[v] + jv * grid.voxel;
    for (let iu = 0; iu < nu; iu++) {
      const list = buckets[jv * nu + iu];
      if (!list) continue;
      const rowU = grid.origin[u] + iu * grid.voxel;

      hitsT.length = 0;
      hitsDir.length = 0;

      for (let n = 0; n < list.length; n++) {
        const f = list[n], t = f * 3;
        let n0 = ix[t], n1 = ix[t + 1], n2 = ix[t + 2];
        const ia = n0 * 3, ib = n1 * 3, ic = n2 * 3;

        let x0 = p[ia + u], y0 = p[ia + v], z0 = p[ia + axis];
        let x1 = p[ib + u], y1 = p[ib + v], z1 = p[ib + axis];
        let x2 = p[ic + u], y2 = p[ic + v], z2 = p[ic + axis];

        let area = (x1 - x0) * (y2 - y0) - (y1 - y0) * (x2 - x0);
        if (area === 0) continue; // edge-on to the ray: contributes nothing

        // A face turning anticlockwise as seen from +axis has its normal along
        // the ray, so crossing it leaves the solid. Record that, then put the
        // triangle in anticlockwise order so one fill rule covers both cases.
        let direction;
        if (area > 0) {
          direction = -1;
        } else {
          direction = 1;
          area = -area;
          let sx = x1, sy = y1, sz = z1, sn = n1;
          x1 = x2; y1 = y2; z1 = z2; n1 = n2;
          x2 = sx; y2 = sy; z2 = sz; n2 = sn;
        }

        const w0 = edgeValue(rowU, rowV, x1, y1, x2, y2, n1, n2);
        const w1 = edgeValue(rowU, rowV, x2, y2, x0, y0, n2, n0);
        const w2 = edgeValue(rowU, rowV, x0, y0, x1, y1, n0, n1);
        if (w0 < 0 || w1 < 0 || w2 < 0) continue;

        // Top-left rule: a ray landing exactly on an edge shared by two
        // triangles must be claimed by exactly one of them. Exact hits are not
        // a curiosity — a symmetric model puts grid lines straight down its own
        // diagonals, which is how a sphere ends up with a hole at its pole.
        if (w0 === 0 && !topLeft(x2 - x1, y2 - y1)) continue;
        if (w1 === 0 && !topLeft(x0 - x2, y0 - y2)) continue;
        if (w2 === 0 && !topLeft(x1 - x0, y1 - y0)) continue;

        const sum = w0 + w1 + w2;
        if (sum === 0) continue;
        hitsT.push((w0 * z0 + w1 * z1 + w2 * z2) / sum);
        hitsDir.push(direction);
      }

      if (hitsT.length === 0) continue;

      order.length = hitsT.length;
      for (let n = 0; n < hitsT.length; n++) order[n] = n;
      order.sort((x, y) => hitsT[x] - hitsT[y]);

      const base = iu * strideU + jv * strideV;

      // Record where each crossing falls, for the surface extraction.
      if (crossings) {
        for (let n = 0; n < order.length; n++) {
          const value = hitsT[order[n]];
          const local = (value - grid.origin[axis]) / grid.voxel;
          const cell = Math.floor(local);
          if (cell < 0 || cell >= nAxis - 1) continue;
          const key = base + cell * strideAxis;
          if (!crossings.has(key)) crossings.set(key, local - cell);
        }
      }

      if (!signs) continue;

      // Walk the line from outside, accumulating the winding number.
      let winding = 0;
      let next = 0;
      for (let k = 0; k < nAxis; k++) {
        const coordinate = grid.origin[axis] + k * grid.voxel;
        while (next < order.length && hitsT[order[next]] <= coordinate) {
          winding += hitsDir[order[next]];
          next++;
        }
        if (winding !== 0) signs[base + k * strideAxis] = 1;
      }
    }
  }
}

/**
 * Force the outer shell of the grid empty.
 *
 * Quads are only emitted where all four cells around a grid edge exist, so an
 * edge lying on the very rim of the grid can never get one. If solid reaches
 * the rim the surface cannot close there, and the result has a hole in it.
 *
 * Normally the padding keeps the model well clear. But an open surface — a
 * model still missing a face when this runs — has no inside to speak of: a ray
 * entering through the gap never comes out, so everything beyond it reads as
 * solid all the way to the edge of the grid. Sealing the rim means the answer
 * is at worst a poor guess about an unanswerable question, rather than another
 * broken mesh. The count of what had to be cleared is reported, because a large
 * one means exactly that.
 */
function sealBoundary(grid, signs) {
  const [nx, ny, nz] = grid.dims;
  const strides = [1, nx, nx * ny];
  const limits = [nx, ny, nz];
  let cleared = 0;

  for (let axis = 0; axis < 3; axis++) {
    const u = (axis + 1) % 3, v = (axis + 2) % 3;
    const position = [0, 0, 0];
    for (const layer of [0, 1, limits[axis] - 2, limits[axis] - 1]) {
      if (layer < 0 || layer >= limits[axis]) continue;
      for (let c = 0; c < limits[v]; c++) {
        for (let b = 0; b < limits[u]; b++) {
          position[axis] = layer; position[u] = b; position[v] = c;
          const index = position[0] * strides[0] + position[1] * strides[1] + position[2] * strides[2];
          if (signs[index]) { signs[index] = 0; cleared++; }
        }
      }
    }
  }
  return cleared;
}

/**
 * Break up checkerboard patterns in the sign grid.
 *
 * Where a cell face has two diagonally opposite corners inside and the other
 * two outside, the surface through that face is genuinely ambiguous: it can be
 * read as two solids touching along a diagonal, or one solid pinched. Surface
 * nets gives each cell a single vertex either way, so the two cells end up
 * joined by four quads along one edge instead of two, and the result is
 * non-manifold exactly where the model was already delicate.
 *
 * Rather than extract the ambiguity and repair it afterwards — which means
 * splitting hundreds of pinch points and patching the holes, and the patches
 * cut straight through the surrounding surface — the ambiguity is settled
 * first, by filling the diagonal in. The change is sub-voxel, it only ever adds
 * material, and thickening a neck too thin to print is the right way to be
 * wrong.
 *
 * Filling can create a new checkerboard next door, so this repeats until
 * nothing changes. It only ever turns grid points solid, so it must terminate.
 */
function resolveAmbiguousFaces(grid, signs) {
  const [nx, ny, nz] = grid.dims;
  const strides = [1, nx, nx * ny];
  const limits = [nx, ny, nz];
  let flipped = 0;

  for (let pass = 0; pass < 8; pass++) {
    let changed = 0;
    for (let axis = 0; axis < 3; axis++) {
      const u = (axis + 1) % 3, v = (axis + 2) % 3;
      const su = strides[u], sv = strides[v];
      const position = [0, 0, 0];
      for (let a = 0; a < limits[axis]; a++) {
        for (let c = 0; c < limits[v] - 1; c++) {
          for (let b = 0; b < limits[u] - 1; b++) {
            position[axis] = a; position[u] = b; position[v] = c;
            const base = position[0] * strides[0] + position[1] * strides[1] + position[2] * strides[2];
            const c00 = signs[base];
            const c10 = signs[base + su];
            const c01 = signs[base + sv];
            const c11 = signs[base + su + sv];
            if (c00 && c11 && !c10 && !c01) {
              signs[base + su] = 1; signs[base + sv] = 1;
              changed += 2;
            } else if (c10 && c01 && !c00 && !c11) {
              signs[base] = 1; signs[base + su + sv] = 1;
              changed += 2;
            }
          }
        }
      }
    }
    flipped += changed;
    if (changed === 0) break;
  }
  return flipped;
}

/**
 * Naive surface nets: one vertex per cell that straddles the boundary, one quad
 * per grid edge that crosses it.
 *
 * Chosen over marching cubes because it needs no lookup tables, produces a
 * closed manifold surface by construction, and gives smoother results on the
 * blocky fields that voxelisation produces.
 */
function surfaceNets(grid, signs, crossings) {
  const [nx, ny, nz] = grid.dims;
  const strideY = nx, strideZ = nx * ny;
  const strides = [1, strideY, strideZ];

  const cellVertex = new Int32Array((nx - 1) * (ny - 1) * (nz - 1)).fill(-1);
  const positions = [];
  const indices = [];

  const cellIndex = (i, j, k) => i + j * (nx - 1) + k * (nx - 1) * (ny - 1);

  // The 12 edges of a cell, as pairs of its 8 corners.
  const CORNER = [[0,0,0],[1,0,0],[1,1,0],[0,1,0],[0,0,1],[1,0,1],[1,1,1],[0,1,1]];
  const EDGE = [[0,1],[1,2],[3,2],[0,3],[4,5],[5,6],[7,6],[4,7],[0,4],[1,5],[2,6],[3,7]];

  for (let k = 0; k < nz - 1; k++) {
    for (let j = 0; j < ny - 1; j++) {
      for (let i = 0; i < nx - 1; i++) {
        const base = i + j * strideY + k * strideZ;
        let mask = 0;
        for (let c = 0; c < 8; c++) {
          const o = CORNER[c];
          if (signs[base + o[0] + o[1] * strideY + o[2] * strideZ]) mask |= 1 << c;
        }
        if (mask === 0 || mask === 255) continue;

        let sx = 0, sy = 0, sz = 0, n = 0;
        for (let e = 0; e < 12; e++) {
          const c0 = CORNER[EDGE[e][0]], c1 = CORNER[EDGE[e][1]];
          const b0 = (mask >> EDGE[e][0]) & 1, b1 = (mask >> EDGE[e][1]) & 1;
          if (b0 === b1) continue;

          // which axis this cell edge runs along
          const axis = c0[0] !== c1[0] ? 0 : c0[1] !== c1[1] ? 1 : 2;
          const low = c0[axis] < c1[axis] ? c0 : c1;
          const key = (i + low[0]) + (j + low[1]) * strideY + (k + low[2]) * strideZ;
          const fraction = crossings.has(key) ? crossings.get(key) : 0.5;

          const point = [i + low[0], j + low[1], k + low[2]];
          point[axis] += fraction;
          sx += point[0]; sy += point[1]; sz += point[2];
          n++;
        }
        if (n === 0) continue;

        cellVertex[cellIndex(i, j, k)] = positions.length / 3;
        positions.push(
          grid.origin[0] + (sx / n) * grid.voxel,
          grid.origin[1] + (sy / n) * grid.voxel,
          grid.origin[2] + (sz / n) * grid.voxel,
        );
      }
    }
  }

  // One quad per boundary-crossing grid edge, spanning the four cells around it.
  const limits = [nx, ny, nz];
  for (let axis = 0; axis < 3; axis++) {
    const u = (axis + 1) % 3, v = (axis + 2) % 3;
    const position = [0, 0, 0];
    for (let c = 1; c < limits[v]; c++) {
      for (let b = 1; b < limits[u]; b++) {
        for (let a = 0; a < limits[axis] - 1; a++) {
          position[axis] = a; position[u] = b; position[v] = c;
          const p0 = position[0] + position[1] * strideY + position[2] * strideZ;
          const inside0 = signs[p0];
          const inside1 = signs[p0 + strides[axis]];
          if (inside0 === inside1) continue;

          const cells = [
            cellOf(position, u, -1, v, -1),
            cellOf(position, u, 0, v, -1),
            cellOf(position, u, 0, v, 0),
            cellOf(position, u, -1, v, 0),
          ];
          if (cells[0] < 0 || cells[1] < 0 || cells[2] < 0 || cells[3] < 0) continue;
          const q = [cellVertex[cells[0]], cellVertex[cells[1]], cellVertex[cells[2]], cellVertex[cells[3]]];
          if (q[0] < 0 || q[1] < 0 || q[2] < 0 || q[3] < 0) continue;

          // The surface faces whichever way leads out of the solid.
          if (inside0) indices.push(q[0], q[1], q[2], q[0], q[2], q[3]);
          else indices.push(q[0], q[2], q[1], q[0], q[3], q[2]);
        }
      }
    }
  }

  function cellOf(position, u, du, v, dv) {
    const c = [position[0], position[1], position[2]];
    c[u] += du; c[v] += dv;
    if (c[0] < 0 || c[1] < 0 || c[2] < 0) return -1;
    if (c[0] >= nx - 1 || c[1] >= ny - 1 || c[2] >= nz - 1) return -1;
    return cellIndex(c[0], c[1], c[2]);
  }

  return new Mesh(new Float64Array(positions), new Uint32Array(indices));
}

/**
 * Rebuild a mesh as a solid.
 *
 * @param {Mesh} mesh
 * @param {{resolution?: number, voxelSize?: number, onProgress?: Function}} opts
 */
export function rebuildAsSolid(mesh, opts = {}) {
  const onProgress = opts.onProgress || (() => {});
  if (mesh.triangleCount === 0) {
    return { mesh, grid: null, skipped: 'the mesh has no triangles' };
  }

  // Welding first is a precondition, not a courtesy. Deciding which of two
  // triangles owns a ray that lands exactly on the edge between them relies on
  // both naming that edge by the same pair of vertex indices. In an unwelded
  // mesh they do not share indices, the tie-break stops working, and a ray down
  // a model's axis of symmetry counts one crossing twice — which turns
  // everything above it solid and leaves a hole at the pole.
  const welded = weldVertices(mesh, opts.tolerance ?? mesh.defaultEpsilon());
  const source = welded.mesh;

  const grid = planGrid(source, opts);
  const signs = new Uint8Array(grid.points);
  const crossings = new Map();

  // The Z pass decides inside from outside; all three record where the surface
  // actually sits, so the rebuilt vertices land on the original geometry
  // instead of snapping to grid lines.
  stab(source, grid, 2, signs, crossings, (f) => onProgress(f * 0.3, 'Sampling the solid'));
  stab(source, grid, 0, null, crossings, (f) => onProgress(0.3 + f * 0.2, 'Sampling the solid'));
  stab(source, grid, 1, null, crossings, (f) => onProgress(0.5 + f * 0.2, 'Sampling the solid'));

  let inside = 0;
  for (let i = 0; i < signs.length; i++) if (signs[i]) inside++;
  if (inside === 0) {
    return { mesh, grid, skipped: 'nothing registered as solid — the surface may be too open to sample' };
  }

  onProgress(0.7, 'Rebuilding the surface');
  const cleared = sealBoundary(grid, signs);

  onProgress(0.72, 'Rebuilding the surface');
  const filled = resolveAmbiguousFaces(grid, signs);
  // Filling a diagonal can push solid back out to the rim; seal it again.
  if (filled > 0) sealBoundary(grid, signs);

  onProgress(0.78, 'Rebuilding the surface');
  let rebuilt = surfaceNets(grid, signs, crossings);
  if (rebuilt.triangleCount === 0) {
    return { mesh, grid, skipped: 'the rebuilt surface came out empty' };
  }

  // Smoothing was tried here and taken out again. Taubin passes tidied the
  // slight blotchiness of the extracted vertices — about 4% off the RMS
  // deviation — but where two surfaces run close together they walked vertices
  // through each other and put back the self-intersections this mode exists to
  // remove. Clamping the displacement did not help: in a tight crease the gap
  // is smaller than any useful clamp. A guaranteed-clean solid is worth more
  // than a slightly smoother one.
  onProgress(0.9, 'Tidying the rebuilt surface');
  const tidy = tidyRebuild(rebuilt, grid);
  rebuilt = tidy.mesh;
  rebuilt.name = mesh.name;
  rebuilt.unit = mesh.unit;
  onProgress(1, 'Tidying the rebuilt surface');

  return {
    mesh: rebuilt,
    grid,
    insideVoxels: inside,
    ambiguousFilled: filled,
    boundaryCleared: cleared,
    cleanup: tidy.report,
    skipped: null,
  };
}

/**
 * Clean up after the extraction, so what comes back is a solid rather than
 * something the caller has to repair again.
 *
 * Two artefacts are inherent to the method and worth naming. Specks: a feature
 * thinner than a voxel samples as a handful of stray cells, which surface as
 * tiny closed shells. And pinches: where a cell face has two diagonally
 * opposite corners inside and two outside, the surface is genuinely ambiguous
 * there, and the quads meet along an edge used by four faces instead of two.
 * Both are local, so both are fixed locally.
 */
function tidyRebuild(mesh, grid) {
  const report = { degenerate: 0, specks: 0, pinches: 0, patched: 0, collapsed: 0, flippedShells: 0 };

  const degenerate = removeDegenerateTriangles(mesh, 0);
  report.degenerate = degenerate.removed;
  let current = degenerate.mesh;

  // Any zero-length edges the extraction leaves behind are collapsed rather
  // than cut out: deleting the triangle would only leave a hole that fills
  // straight back in as the same triangle.
  const collapsed = collapseDegenerateEdges(current, 0);
  report.collapsed = collapsed.removed;
  current = collapsed.mesh;

  // Two lumps of solid can still meet at a single grid point, which shows up as
  // a vertex the surface passes through twice. Pulling those apart is safe
  // here: with no over-used edges left, each sheet around the point is already
  // a closed fan, so separating them opens nothing.
  const edges = buildEdgeTable(current);
  report.nonManifoldEdges = classifyEdges(edges).nonManifold;
  if (nonManifoldVertices(current, edges).length > 0) {
    const split = splitNonManifoldVertices(current, edges);
    report.pinches = split.verticesSplit;
    current = split.mesh;
  }

  // Anything smaller than a couple of voxels across is sampling noise, not a
  // part of the model. Measured absolutely, because a speck beside a large
  // model and a speck beside a small one are equally not real.
  const floor = (grid.voxel * 2.5) ** 3;
  const debris = removeDebrisShells(current, { minVolumeRatio: 0, minAbsoluteVolume: floor });
  report.specks = debris.removed;
  current = debris.mesh;

  const componentEdges = buildEdgeTable(current);
  const comps = faceComponents(current, componentEdges);
  const outward = makeNormalsOutward(current, comps.comp, comps.count);
  if (outward.flippedShells) current = applyFlips(current, outward.flip);
  report.flippedShells = outward.flippedShells;

  current = removeUnusedVertices(current).mesh;
  return { mesh: current, report };
}
