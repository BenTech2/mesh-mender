/**
 * Shells: the separate connected bodies inside one mesh.
 *
 * Scanned and downloaded models routinely carry a few stray triangles or a
 * pea-sized blob floating inside the model. They print as scattered specks or
 * make the slicer report an impossible object, and they are the single most
 * common thing 3D Builder's repair silently threw away.
 */
import { Mesh } from './core.js';
import { buildEdgeTable, faceComponents } from './topology.js';
import { removeUnusedVertices } from './cleanup.js';
import { componentVolume } from './orient.js';

export function shellInfo(mesh, edges) {
  const e = edges || buildEdgeTable(mesh);
  const { comp, count } = faceComponents(mesh, e);
  const faces = Array.from({ length: count }, () => []);
  for (let f = 0; f < mesh.triangleCount; f++) faces[comp[f]].push(f);

  // Open edges per shell tell us which bodies are watertight.
  const openEdges = new Int32Array(count);
  for (let i = 0; i < e.count; i++) {
    if (e.uses[i].length === 1) openEdges[comp[e.uses[i][0] >> 1]]++;
  }

  const shells = faces.map((list, i) => {
    let area = 0;
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    const p = mesh.positions, ix = mesh.indices;
    for (const f of list) {
      area += mesh.triangleArea(f);
      for (let k = 0; k < 3; k++) {
        const v = ix[f * 3 + k] * 3;
        for (let a = 0; a < 3; a++) {
          if (p[v + a] < min[a]) min[a] = p[v + a];
          if (p[v + a] > max[a]) max[a] = p[v + a];
        }
      }
    }
    const volume = componentVolume(mesh, list);
    return {
      index: i,
      faces: list,
      triangleCount: list.length,
      area,
      volume,
      absVolume: Math.abs(volume),
      openEdges: openEdges[i],
      closed: openEdges[i] === 0,
      size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]],
      diagonal: Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]),
    };
  });

  return { comp, count, shells };
}

/** Keep only the shells whose index is in `keep`. */
export function keepShells(mesh, comp, keep) {
  const keepSet = keep instanceof Set ? keep : new Set(keep);
  const ix = mesh.indices;
  const out = [];
  for (let f = 0; f < mesh.triangleCount; f++) {
    if (!keepSet.has(comp[f])) continue;
    const t = f * 3;
    out.push(ix[t], ix[t + 1], ix[t + 2]);
  }
  const m = new Mesh(mesh.positions, new Uint32Array(out));
  m.name = mesh.name; m.unit = mesh.unit;
  return m;
}

/**
 * Drop debris shells.
 *
 * `minVolumeRatio` and `minTriangleRatio` are measured against the biggest
 * shell, so the test travels with the model instead of depending on its units.
 */
export function removeDebrisShells(mesh, opts = {}) {
  const {
    minVolumeRatio = 0.001,
    minTriangleRatio = 0,
    keepLargestOnly = false,
    // An absolute floor, for callers that know the size below which a body is
    // noise — voxel remeshing, where anything under a few voxels is an artefact
    // of the sampling rather than part of the model.
    minAbsoluteVolume = 0,
  } = opts;
  const info = shellInfo(mesh);
  if (info.count <= 1) return { mesh, removed: 0, removedTriangles: 0, shells: info.shells };

  let maxVol = 0, maxTris = 0;
  for (const s of info.shells) {
    if (s.absVolume > maxVol) maxVol = s.absVolume;
    if (s.triangleCount > maxTris) maxTris = s.triangleCount;
  }
  const biggest = info.shells.reduce((a, b) => (b.absVolume > a.absVolume ? b : a));

  const keep = new Set();
  for (const s of info.shells) {
    if (keepLargestOnly) { if (s.index === biggest.index) keep.add(s.index); continue; }
    const volOk = maxVol > 0 ? s.absVolume >= maxVol * minVolumeRatio : true;
    const triOk = s.triangleCount >= maxTris * minTriangleRatio;
    const absOk = s.absVolume >= minAbsoluteVolume;
    if (volOk && triOk && absOk) keep.add(s.index);
  }
  if (keep.size === 0) keep.add(biggest.index);

  let removedTriangles = 0;
  for (const s of info.shells) if (!keep.has(s.index)) removedTriangles += s.triangleCount;
  if (removedTriangles === 0) return { mesh, removed: 0, removedTriangles: 0, shells: info.shells };

  return {
    mesh: keepShells(mesh, info.comp, keep),
    removed: info.count - keep.size,
    removedTriangles,
    shells: info.shells,
  };
}

/** Explode a mesh into one Mesh per shell. */
export function separateShells(mesh) {
  const info = shellInfo(mesh);
  const out = [];
  for (const s of info.shells) {
    // Compact as we go: each part would otherwise inherit the whole model's
    // vertex array and report tens of thousands of unused vertices of its own.
    const part = removeUnusedVertices(keepShells(mesh, info.comp, [s.index])).mesh;
    part.name = mesh.name ? `${mesh.name} (part ${s.index + 1})` : `part ${s.index + 1}`;
    part.unit = mesh.unit;
    out.push(part);
  }
  return out;
}
