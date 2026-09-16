/**
 * The repair pipeline.
 *
 * Order matters more than any individual step. Welding first is what makes the
 * rest possible: until coincident vertices are merged, an STL has no topology
 * at all and every edge looks open. Holes are filled only after the mesh has
 * been made manifold and consistently wound, because filling a hole whose rim
 * is itself broken just produces more broken surface.
 *
 * Steps are individually switchable so a model that only needs one thing doing
 * is not silently rebuilt from end to end.
 */
import { weldVertices, removeDegenerateTriangles, removeDuplicateTriangles,
         removeUnusedVertices } from './cleanup.js';
import { buildEdgeTable, classifyEdges, faceComponents } from './topology.js';
import { splitNonManifoldVertices } from './nonmanifold.js';
import { makeWindingConsistent, applyFlips, makeNormalsOutward } from './orient.js';
import { fillHoles } from './holes.js';
import { removeDebrisShells } from './shells.js';
import { resolveSelfIntersections } from './intersect.js';
import { rebuildAsSolid } from './voxel.js';
import { analyze } from './analyze.js';

export const DEFAULT_OPTIONS = {
  weld: true,
  weldTolerance: 'auto',       // 'auto' => 1e-6 x bounding-box diagonal
  removeDegenerate: true,
  removeDuplicates: true,
  removeOppositeDuplicates: true,
  splitNonManifold: true,
  removeDebris: true,
  debrisVolumeRatio: 0.001,
  keepLargestOnly: false,
  fillHoles: true,
  maxHoleEdges: Infinity,
  fixWinding: true,
  outwardNormals: true,
  fixSelfIntersections: false,  // destructive, opt-in
  selfIntersectionDilate: 0,    // widening the cut snowballs; opt in deliberately
  maxSelfIntersectionRemoval: 0.25,
  rebuildAsSolid: false,        // experimental: resamples the whole model
  rebuildResolution: 192,
  passes: 2,
};

/**
 * @param {import('./core.js').Mesh} mesh
 * @param {Partial<typeof DEFAULT_OPTIONS>} options
 * @param {(fraction:number, label:string)=>void} [onProgress]
 */
export function repair(mesh, options = {}, onProgress = () => {}) {
  const opt = { ...DEFAULT_OPTIONS, ...options };
  const log = [];
  let current = mesh;

  const tolerance = opt.weldTolerance === 'auto' || opt.weldTolerance == null
    ? current.defaultEpsilon()
    : Number(opt.weldTolerance);

  const before = analyze(current, {
    tolerance,
    checkSelfIntersections: opt.fixSelfIntersections || opt.analyseSelfIntersections !== false,
  });

  const note = (step, message, changed = true, stats = null) => {
    log.push({ step, message, changed, stats });
  };

  const steps = [];

  if (opt.removeDegenerate) {
    steps.push(['Remove zero-area triangles', () => {
      const r = removeDegenerateTriangles(current, 0); // exact only, pre-weld
      current = r.mesh;
      return r.removed ? `removed ${r.removed} triangle${r.removed === 1 ? '' : 's'} with repeated corners` : null;
    }]);
  }

  if (opt.weld) {
    steps.push(['Weld vertices', () => {
      const r = weldVertices(current, tolerance);
      current = r.mesh;
      return r.merged
        ? `merged ${r.merged} coincident vertices (tolerance ${formatNumber(tolerance)})`
        : null;
    }]);
    steps.push(['Remove collapsed triangles', () => {
      const r = removeDegenerateTriangles(current, tolerance * tolerance);
      current = r.mesh;
      if (!r.removed) return null;
      const bits = [];
      if (r.removedRepeat) bits.push(`${r.removedRepeat} collapsed by welding`);
      if (r.removedSliver) bits.push(`${r.removedSliver} slivers`);
      return `removed ${r.removed} triangle${r.removed === 1 ? '' : 's'} (${bits.join(', ')})`;
    }]);
  }

  if (opt.removeDuplicates) {
    steps.push(['Remove duplicate faces', () => {
      const r = removeDuplicateTriangles(current, { removeOpposite: opt.removeOppositeDuplicates });
      current = r.mesh;
      if (!r.removed) return null;
      const bits = [];
      if (r.identical) bits.push(`${r.identical} repeated`);
      if (r.opposite) bits.push(`${r.opposite} back-to-back (zero-thickness fins)`);
      return `removed ${r.removed} triangle${r.removed === 1 ? '' : 's'}: ${bits.join(', ')}`;
    }]);
  }

  if (opt.splitNonManifold) {
    steps.push(['Separate pinched geometry', () => {
      const edges = buildEdgeTable(current);
      const r = splitNonManifoldVertices(current, edges);
      current = r.mesh;
      return r.verticesSplit
        ? `split ${r.verticesSplit} non-manifold ${r.verticesSplit === 1 ? 'vertex' : 'vertices'} into ${r.verticesSplit + r.copiesMade} copies`
        : null;
    }]);
  }

  if (opt.removeDebris) {
    steps.push(['Remove stray shells', () => {
      const r = removeDebrisShells(current, {
        minVolumeRatio: opt.keepLargestOnly ? 0 : opt.debrisVolumeRatio,
        keepLargestOnly: opt.keepLargestOnly,
      });
      current = r.mesh;
      return r.removed
        ? `discarded ${r.removed} stray shell${r.removed === 1 ? '' : 's'} (${r.removedTriangles} triangles)`
        : null;
    }]);
  }

  if (opt.fixWinding) {
    steps.push(['Make winding consistent', () => {
      const edges = buildEdgeTable(current);
      const w = makeWindingConsistent(current, edges);
      if (w.flipped === 0) return w.conflicts ? `left ${w.conflicts} unorientable edges alone` : null;
      current = applyFlips(current, w.flip);
      const extra = w.conflicts ? `; ${w.conflicts} edges could not be made consistent` : '';
      return `re-wound ${w.flipped} face${w.flipped === 1 ? '' : 's'} across ${w.components} shell${w.components === 1 ? '' : 's'}${extra}`;
    }]);
  }

  if (opt.fillHoles) {
    steps.push(['Fill holes', () => {
      const r = fillHoles(current, { maxLoopEdges: opt.maxHoleEdges });
      current = r.mesh;
      if (!r.holesFilled) return r.skipped ? `left ${r.skipped} oversized holes open` : null;
      let biggest = 0;
      for (const h of r.holes) if (h.filled && h.edges > biggest) biggest = h.edges;
      const tail = r.skipped ? `; skipped ${r.skipped} over the size limit` : '';
      return `closed ${r.holesFilled} hole${r.holesFilled === 1 ? '' : 's'} with ${r.trianglesAdded} new triangles (largest had ${biggest} edges)${tail}`;
    }]);
  }

  if (opt.fixSelfIntersections) {
    steps.push(['Resolve self-intersections', () => {
      const r = resolveSelfIntersections(current, {
        dilate: opt.selfIntersectionDilate,
        maxRemovalFraction: opt.maxSelfIntersectionRemoval,
      });
      current = r.mesh;
      if (r.aborted && !r.removed) return `left alone — ${r.aborted}`;
      if (!r.removed) return null;
      const left = r.remaining ? `; ${r.remaining} pairs still intersect` : '';
      const stopped = r.aborted ? `; stopped early because ${r.aborted}` : '';
      return `cut out ${r.removed} intersecting triangles and re-closed the gaps with ${r.added}${left}${stopped}`;
    }]);
  }

  if (opt.outwardNormals) {
    steps.push(['Point normals outwards', () => {
      const edges = buildEdgeTable(current);
      const comps = faceComponents(current, edges);
      const r = makeNormalsOutward(current, comps.comp, comps.count);
      if (!r.flippedShells) return null;
      current = applyFlips(current, r.flip);
      return `turned ${r.flippedShells} inside-out shell${r.flippedShells === 1 ? '' : 's'} the right way round`;
    }]);
  }

  steps.push(['Tidy up', () => {
    const r = removeUnusedVertices(current);
    current = r.mesh;
    return r.removed ? `dropped ${r.removed} unused vertices` : null;
  }]);

  const passes = Math.max(1, opt.passes | 0);
  let totalUnits = steps.length * passes;
  let done = 0;

  for (let pass = 0; pass < passes; pass++) {
    let changedThisPass = false;
    for (const [name, run] of steps) {
      onProgress(done / totalUnits, name);
      const at = done;
      const message = run((fraction, label) => {
        onProgress((at + Math.max(0, Math.min(1, fraction))) / totalUnits, label || name);
      });
      done++;
      if (message) {
        changedThisPass = true;
        note(name, message, true);
      } else if (pass === 0) {
        note(name, 'nothing to do', false);
      }
    }
    // A second pass only earns its keep when the first one changed something;
    // it catches holes opened by fin removal and similar knock-on effects.
    if (!changedThisPass) {
      done = totalUnits;
      break;
    }
    const edges = buildEdgeTable(current);
    const stats = classifyEdges(edges);
    if (stats.boundary === 0 && stats.nonManifold === 0 && stats.inconsistent === 0) {
      done = totalUnits;
      break;
    }
  }

  // The rebuild runs last, on its own, and only once.
  //
  // Order is not a detail here. It reads the model's orientation to decide what
  // is solid, so every shell has to be facing outwards before it starts —
  // an inside-out body contributes -1 where its neighbour contributes +1, the
  // two cancel, and the overlap is carved out instead of merged. It also has to
  // be the end of the line: the repairs above would treat its output as a new
  // mesh to pick apart, and a second rebuild would resample an already
  // resampled surface.
  if (opt.rebuildAsSolid) {
    onProgress(0.9, 'Rebuild as a solid');
    const r = rebuildAsSolid(current, {
      resolution: opt.rebuildResolution,
      voxelSize: opt.rebuildVoxelSize,
      onProgress: (fraction, label) => onProgress(0.9 + fraction * 0.08, label),
    });
    if (r.skipped) {
      note('Rebuild as a solid', `could not rebuild — ${r.skipped}`, false);
    } else {
      const incoming = current.triangleCount;
      current = r.mesh;

      // Light tidying only: surface nets can leave a flat triangle where a
      // quad's corners line up, and stray specks where a feature was thinner
      // than one voxel. Nothing that would re-cut the surface.
      const degenerate = removeDegenerateTriangles(current, 0);
      current = degenerate.mesh;
      const debris = removeDebrisShells(current, { minVolumeRatio: opt.debrisVolumeRatio });
      current = debris.mesh;
      const outward = (() => {
        const edges = buildEdgeTable(current);
        const comps = faceComponents(current, edges);
        const flips = makeNormalsOutward(current, comps.comp, comps.count);
        if (flips.flippedShells) current = applyFlips(current, flips.flip);
        return flips.flippedShells;
      })();
      current = removeUnusedVertices(current).mesh;

      const extras = [];
      if (degenerate.removed) extras.push(`${degenerate.removed} flat triangles trimmed`);
      if (debris.removed) extras.push(`${debris.removed} specks below one voxel discarded`);
      if (outward) extras.push(`${outward} shells turned outwards`);
      if (r.grid.reduced) extras.push(`resolution reduced to ${r.grid.resolution} to stay within memory`);

      note('Rebuild as a solid',
        `rebuilt from a ${r.grid.dims.join('×')} grid at ${formatNumber(r.grid.voxel)} per voxel — `
        + `${incoming} triangles in, ${current.triangleCount} out`
        + (extras.length ? ` (${extras.join(', ')})` : ''));
    }
  }

  onProgress(1, 'Checking result');
  const after = analyze(current, {
    tolerance,
    checkSelfIntersections: before.selfIntersections != null,
  });

  return { mesh: current, before, after, log, tolerance };
}

function formatNumber(n) {
  if (n === 0) return '0';
  const abs = Math.abs(n);
  if (abs < 1e-4 || abs >= 1e6) return n.toExponential(2);
  return String(Number(n.toPrecision(4)));
}
