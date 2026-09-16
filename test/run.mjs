/**
 * Test suite. Run with `node test/run.mjs`.
 *
 * The repair code has no DOM dependencies precisely so it can be tested like
 * this; the browser only ever sees numbers it has already been proved to get
 * right here.
 */
import { Mesh } from '../js/mesh/core.js';
import * as Topo from '../js/mesh/topology.js';
import * as Cleanup from '../js/mesh/cleanup.js';
import * as Orient from '../js/mesh/orient.js';
import { fillHoles, triangulateLoop } from '../js/mesh/holes.js';
import { splitNonManifoldVertices } from '../js/mesh/nonmanifold.js';
import { shellInfo, removeDebrisShells, separateShells } from '../js/mesh/shells.js';
import { findSelfIntersections, classifyIntersections, triTriIntersect } from '../js/mesh/intersect.js';
import { analyze, collectHighlights } from '../js/mesh/analyze.js';
import { repair } from '../js/mesh/repair.js';
import { rebuildAsSolid, planGrid } from '../js/mesh/voxel.js';
import { loadFile, exportMeshes, EXPORT_FORMATS } from '../js/io/index.js';
import { parseModelXML } from '../js/io/threemf.js';
import {
  cube, cubeSoup, sphere, sphereTriangles, meshFromTriangles, rng,
  referenceIntersect, triangleOf, CUBE_POSITIONS, CUBE_INDICES,
} from './fixtures.mjs';

let passed = 0, failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    process.stdout.write('.');
  } catch (error) {
    failed++;
    failures.push({ name, error });
    process.stdout.write('F');
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'assertion failed');
}
function equal(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message || 'values differ'}: got ${actual}, expected ${expected}`);
  }
}
function close(actual, expected, tolerance, message) {
  if (Math.abs(actual - expected) > tolerance) {
    throw new Error(`${message || 'values differ'}: got ${actual}, expected ${expected} ±${tolerance}`);
  }
}

/* ------------------------------------------------------------------- core */

test('cube geometry: volume, area and bounds', () => {
  const m = cube();
  equal(m.triangleCount, 12);
  equal(m.vertexCount, 8);
  close(m.signedVolume(), 1, 1e-12, 'volume');
  close(m.surfaceArea(), 6, 1e-12, 'area');
  const b = m.bounds();
  equal(b.size[0], 1);
  close(b.diagonal, Math.sqrt(3), 1e-12);
});

test('flipAll inverts the sign of the volume', () => {
  const m = cube();
  m.flipAll();
  close(m.signedVolume(), -1, 1e-12);
});

test('a mirroring matrix flips winding so volume stays positive', () => {
  const m = cube();
  m.applyMatrix4([-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  close(m.signedVolume(), 1, 1e-12, 'volume after mirror');
});

/* --------------------------------------------------------------- topology */

test('a closed cube has no boundary and no non-manifold edges', () => {
  const m = cube();
  const edges = Topo.buildEdgeTable(m);
  const stats = Topo.classifyEdges(edges);
  equal(stats.boundary, 0, 'boundary edges');
  equal(stats.nonManifold, 0, 'non-manifold edges');
  equal(stats.inconsistent, 0, 'inconsistent edges');
  equal(stats.manifold, 18, 'manifold edges');
  equal(Topo.faceComponents(m, edges).count, 1, 'shells');
});

test('removing a face produces one boundary loop, wound for filling', () => {
  const indices = CUBE_INDICES.slice(0, 4 * 3).concat(CUBE_INDICES.slice(6 * 3));
  const m = new Mesh(new Float64Array(CUBE_POSITIONS), new Uint32Array(indices));
  const edges = Topo.buildEdgeTable(m);
  equal(Topo.classifyEdges(edges).boundary, 4, 'open edges');
  const loops = Topo.boundaryLoops(m, edges);
  equal(loops.length, 1, 'loops');
  equal(loops[0].length, 4, 'loop length');
});

test('two cubes touching at a corner give one non-manifold vertex', () => {
  const a = cube(1), b = cube(0.5, [1, 1, 1]);
  const positions = new Float64Array([...a.positions, ...b.positions]);
  const indices = new Uint32Array([...a.indices, ...Array.from(b.indices, (i) => i + 8)]);
  const welded = Cleanup.weldVertices(new Mesh(positions, indices), 1e-9).mesh;
  const edges = Topo.buildEdgeTable(welded);
  equal(Topo.nonManifoldVertices(welded, edges).length, 1, 'pinched vertices');
});

/* ---------------------------------------------------------------- cleanup */

test('welding rebuilds topology from an STL-style soup', () => {
  const soup = cubeSoup();
  equal(soup.vertexCount, 36);
  const { mesh, merged } = Cleanup.weldVertices(soup, 1e-6);
  equal(merged, 28, 'merged vertices');
  equal(mesh.vertexCount, 8);
  const stats = Topo.classifyEdges(Topo.buildEdgeTable(mesh));
  equal(stats.boundary, 0, 'boundary edges after welding');
  close(mesh.signedVolume(), 1, 1e-12);
});

test('welding tolerance is respected', () => {
  const positions = new Float64Array([0, 0, 0, 0.5, 0, 0, 0, 0.5, 0, 1e-4, 0, 0]);
  const m = new Mesh(positions, new Uint32Array([0, 1, 2, 3, 1, 2]));
  equal(Cleanup.weldVertices(m, 1e-6).merged, 0, 'below tolerance, nothing merges');
  equal(Cleanup.weldVertices(m, 1e-3).merged, 1, 'above tolerance, one merges');
});

test('degenerate triangles are removed', () => {
  const m = new Mesh(new Float64Array(CUBE_POSITIONS), new Uint32Array([...CUBE_INDICES, 1, 1, 3]));
  const r = Cleanup.removeDegenerateTriangles(m, 0);
  equal(r.removed, 1);
  equal(r.mesh.triangleCount, 12);
});

test('duplicate faces: repeats drop one copy, fins drop both', () => {
  const m = cube();
  const repeated = new Mesh(m.positions, new Uint32Array([...m.indices, m.indices[0], m.indices[1], m.indices[2]]));
  const a = Cleanup.removeDuplicateTriangles(repeated);
  equal(a.identical, 1, 'identical removed');
  equal(a.opposite, 0, 'opposite removed');

  const finned = new Mesh(m.positions, new Uint32Array([...m.indices, m.indices[0], m.indices[2], m.indices[1]]));
  const b = Cleanup.removeDuplicateTriangles(finned);
  equal(b.opposite, 2, 'both halves of the fin removed');
  equal(b.mesh.triangleCount, 11);
});

test('unused vertices are compacted away', () => {
  const positions = new Float64Array([...CUBE_POSITIONS, 9, 9, 9]);
  const m = new Mesh(positions, new Uint32Array(CUBE_INDICES));
  const r = Cleanup.removeUnusedVertices(m);
  equal(r.removed, 1);
  equal(r.mesh.vertexCount, 8);
  close(r.mesh.signedVolume(), 1, 1e-12);
});

/* ------------------------------------------------------------ orientation */

test('inconsistent winding is repaired', () => {
  const indices = CUBE_INDICES.slice();
  for (const f of [1, 4, 7, 9]) {
    const t = f * 3;
    const s = indices[t + 1]; indices[t + 1] = indices[t + 2]; indices[t + 2] = s;
  }
  let m = new Mesh(new Float64Array(CUBE_POSITIONS), new Uint32Array(indices));
  let edges = Topo.buildEdgeTable(m);
  assert(Topo.classifyEdges(edges).inconsistent > 0, 'starts inconsistent');

  const w = Orient.makeWindingConsistent(m, edges);
  m = Orient.applyFlips(m, w.flip);
  edges = Topo.buildEdgeTable(m);
  equal(Topo.classifyEdges(edges).inconsistent, 0, 'inconsistent edges after repair');
  equal(w.conflicts, 0, 'no unorientable edges');
});

test('an inside-out shell is turned the right way round', () => {
  let m = cube().flipAll();
  close(m.signedVolume(), -1, 1e-12, 'starts inverted');
  const edges = Topo.buildEdgeTable(m);
  const comps = Topo.faceComponents(m, edges);
  const r = Orient.makeNormalsOutward(m, comps.comp, comps.count);
  m = Orient.applyFlips(m, r.flip);
  equal(r.flippedShells, 1);
  close(m.signedVolume(), 1, 1e-12);
});

test('shells are oriented independently', () => {
  const a = cube(1);
  const b = cube(1, [5, 0, 0]).flipAll();
  const positions = new Float64Array([...a.positions, ...b.positions]);
  const indices = new Uint32Array([...a.indices, ...Array.from(b.indices, (i) => i + 8)]);
  let m = new Mesh(positions, indices);
  const edges = Topo.buildEdgeTable(m);
  const comps = Topo.faceComponents(m, edges);
  equal(comps.count, 2, 'two shells');
  const r = Orient.makeNormalsOutward(m, comps.comp, comps.count);
  m = Orient.applyFlips(m, r.flip);
  equal(r.flippedShells, 1, 'only the inverted shell is flipped');
  close(m.signedVolume(), 2, 1e-12);
});

/* ------------------------------------------------------------------ holes */

test('a square hole is filled and the cube closes exactly', () => {
  const indices = CUBE_INDICES.slice(0, 4 * 3).concat(CUBE_INDICES.slice(6 * 3));
  const m = new Mesh(new Float64Array(CUBE_POSITIONS), new Uint32Array(indices));
  const r = fillHoles(m);
  equal(r.holesFilled, 1);
  equal(r.trianglesAdded, 2);
  const stats = Topo.classifyEdges(Topo.buildEdgeTable(r.mesh));
  equal(stats.boundary, 0, 'watertight');
  equal(stats.inconsistent, 0, 'patch winding agrees with its neighbours');
  close(r.mesh.signedVolume(), 1, 1e-12, 'volume restored');
});

test('several holes at once', () => {
  const indices = CUBE_INDICES.slice(0, 4 * 3)
    .concat(CUBE_INDICES.slice(6 * 3, 8 * 3))
    .concat(CUBE_INDICES.slice(9 * 3));
  const m = new Mesh(new Float64Array(CUBE_POSITIONS), new Uint32Array(indices));
  const r = fillHoles(m);
  equal(r.holesFilled, 2);
  equal(Topo.classifyEdges(Topo.buildEdgeTable(r.mesh)).boundary, 0);
  close(r.mesh.signedVolume(), 1, 1e-12);
});

test('a hole in a curved surface is filled without inverting any patch triangle', () => {
  const tris = sphereTriangles(16, 24, 20);
  const kept = tris.filter((t) => {
    const cx = (t[0][0] + t[1][0] + t[2][0]) / 3;
    const cz = (t[0][2] + t[1][2] + t[2][2]) / 3;
    return !(cx > 12 && cz > 5 && cz < 16);
  });
  const welded = Cleanup.weldVertices(meshFromTriangles(kept), 1e-6).mesh;
  const before = welded.triangleCount;
  const r = fillHoles(welded);
  assert(r.holesFilled >= 1, 'found a hole');
  equal(Topo.classifyEdges(Topo.buildEdgeTable(r.mesh)).boundary, 0, 'closed');
  equal(Topo.classifyEdges(Topo.buildEdgeTable(r.mesh)).inconsistent, 0, 'patch wound consistently');
  assert(r.mesh.triangleCount > before, 'triangles were added');
  assert(r.mesh.signedVolume() > 0, 'volume is positive');
});

test('triangulateLoop returns n-2 triangles for a simple polygon', () => {
  const positions = new Float64Array([0, 0, 0, 2, 0, 0, 2, 2, 0, 1, 3, 0, 0, 2, 0]);
  const tris = triangulateLoop(positions, [0, 1, 2, 3, 4], null);
  equal(tris.length / 3, 3, 'triangle count');
});

/* ---------------------------------------------------------- non-manifold */

test('a pinched vertex is split and both bodies survive', () => {
  const a = cube(1), b = cube(0.5, [1, 1, 1]);
  const positions = new Float64Array([...a.positions, ...b.positions]);
  const indices = new Uint32Array([...a.indices, ...Array.from(b.indices, (i) => i + 8)]);
  const welded = Cleanup.weldVertices(new Mesh(positions, indices), 1e-9).mesh;
  const edges = Topo.buildEdgeTable(welded);
  const r = splitNonManifoldVertices(welded, edges);
  equal(r.verticesSplit, 1);
  const after = Topo.buildEdgeTable(r.mesh);
  equal(Topo.nonManifoldVertices(r.mesh, after).length, 0, 'no pinched vertices remain');
  equal(Topo.classifyEdges(after).boundary, 0, 'both bodies still closed');
  close(r.mesh.signedVolume(), 1 + 0.125, 1e-12, 'volume preserved');
});

test('an edge shared by three faces becomes manifold', () => {
  // two triangles sharing an edge, plus a third fin on the same edge
  const positions = new Float64Array([0, 0, 0, 1, 0, 0, 0.5, 1, 0, 0.5, -1, 0, 0.5, 0, 1]);
  const m = new Mesh(positions, new Uint32Array([0, 1, 2, 1, 0, 3, 0, 1, 4]));
  const edges = Topo.buildEdgeTable(m);
  assert(Topo.classifyEdges(edges).nonManifold === 1, 'starts non-manifold');
  const r = splitNonManifoldVertices(m, edges);
  equal(Topo.classifyEdges(Topo.buildEdgeTable(r.mesh)).nonManifold, 0, 'resolved');
});

/* ----------------------------------------------------------------- shells */

test('debris shells are discarded and the main body kept', () => {
  const big = cube(10);
  const speck = cube(0.2, [50, 50, 50]);
  const positions = new Float64Array([...big.positions, ...speck.positions]);
  const indices = new Uint32Array([...big.indices, ...Array.from(speck.indices, (i) => i + 8)]);
  const m = new Mesh(positions, indices);
  equal(shellInfo(m).count, 2);
  const r = removeDebrisShells(m, { minVolumeRatio: 0.001 });
  equal(r.removed, 1);
  close(r.mesh.signedVolume(), 1000, 1e-9);
});

test('shells can be separated into individual meshes', () => {
  const a = cube(1), b = cube(1, [5, 0, 0]);
  const positions = new Float64Array([...a.positions, ...b.positions]);
  const indices = new Uint32Array([...a.indices, ...Array.from(b.indices, (i) => i + 8)]);
  const parts = separateShells(new Mesh(positions, indices));
  equal(parts.length, 2);
  for (const part of parts) close(part.signedVolume(), 1, 1e-12);
});

/* ---------------------------------------------------- self-intersections */

test('triangle-triangle test: the obvious cases', () => {
  const A = [[0, 0, 0], [1, 0, 0], [0, 1, 0]];
  assert(triTriIntersect(...A, [0.2, 0.2, -1], [0.2, 0.2, 1], [0.6, 0.6, 0]), 'crossing');
  assert(!triTriIntersect(...A, [5, 5, 5], [6, 5, 5], [5, 6, 5]), 'far apart');
  assert(triTriIntersect(...A, [0.1, 0.1, 0], [0.9, 0.1, 0], [0.1, 0.9, 0]), 'coplanar overlap');
  assert(!triTriIntersect(...A, [3, 3, 0], [4, 3, 0], [3, 4, 0]), 'coplanar apart');
  assert(!triTriIntersect(...A, [2, 0, 0], [3, 0, 1], [3, 0, -1]), 'touching a plane but not the triangle');
});

test('a clean sphere reports no self-intersections at any tessellation', () => {
  for (const [rings, segments] of [[20, 20], [60, 60], [120, 120]]) {
    const m = Cleanup.weldVertices(sphere(rings, segments, 50), 1e-9).mesh;
    equal(findSelfIntersections(m).count, 0, `${rings}x${segments} sphere`);
  }
});

test('detection matches an independent reference, pair for pair', () => {
  const a = sphereTriangles(14, 14, 20);
  const b = sphereTriangles(14, 14, 20, [25, 0, 0]);
  const m = Cleanup.weldVertices(meshFromTriangles(a.concat(b)), 1e-9).mesh;
  const found = findSelfIntersections(m);
  const reported = new Set();
  for (let i = 0; i < found.pairs.length; i += 2) reported.add(`${found.pairs[i]}:${found.pairs[i + 1]}`);

  let referenceCount = 0, missed = 0, spurious = 0;
  const shares = (f, g) => {
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) if (m.indices[f * 3 + i] === m.indices[g * 3 + j]) return true;
    }
    return false;
  };
  for (let f = 0; f < m.triangleCount; f++) {
    const A = triangleOf(m, f);
    for (let g = f + 1; g < m.triangleCount; g++) {
      if (shares(f, g)) continue;
      const hit = referenceIntersect(A, triangleOf(m, g));
      if (hit) { referenceCount++; if (!reported.has(`${f}:${g}`)) missed++; }
      else if (reported.has(`${f}:${g}`)) spurious++;
    }
  }
  assert(referenceCount > 0, 'the reference found intersections to compare against');
  equal(missed, 0, 'intersections missed');
  equal(spurious, 0, 'intersections invented');
});

test('overlapping separate bodies are told apart from a body crossing itself', () => {
  const a = sphereTriangles(14, 14, 20);
  const b = sphereTriangles(14, 14, 20, [25, 0, 0]);
  const m = Cleanup.weldVertices(meshFromTriangles(a.concat(b)), 1e-9).mesh;
  const found = findSelfIntersections(m);
  const split = classifyIntersections(m, found.pairs);
  assert(split.between.length > 0, 'found the overlap between the two bodies');
  equal(split.within.length, 0, 'neither body crosses itself');
});

test('a body pulled through itself is caught and marked unprintable', () => {
  const positions = [0, 0, 0, 10, 0, 0, 10, 10, 0, 0, 10, 0, 0, 0, 10, 10, 0, 10, -14, -14, -14, 0, 10, 10];
  const m = new Mesh(new Float64Array(positions), new Uint32Array(CUBE_INDICES));
  const split = classifyIntersections(m, findSelfIntersections(m).pairs);
  assert(split.within.length > 0, 'within-body crossing found');
  const report = analyze(m, { checkSelfIntersections: true });
  equal(report.printable, false, 'reported as not printable');
});

test('cutting self-intersections refuses to eat the model', () => {
  const a = sphereTriangles(16, 16, 20);
  const b = sphereTriangles(16, 16, 20, [12, 0, 0]);
  const m = meshFromTriangles(a.concat(b));
  const r = repair(m, { fixSelfIntersections: true });
  assert(r.after.triangles > m.triangleCount * 0.5,
    `kept most of the model (${r.after.triangles} of ${m.triangleCount})`);
});

test('collectHighlights returns overlay geometry, with and without the intersection scan', () => {
  const indices = CUBE_INDICES.slice(0, 4 * 3).concat(CUBE_INDICES.slice(6 * 3));
  const holed = new Mesh(new Float64Array(CUBE_POSITIONS), new Uint32Array(indices));
  const plain = collectHighlights(holed);
  equal(plain.boundaryEdges.length / 2, 4, 'open edges highlighted');
  equal(plain.intersectingFaces.length, 0, 'no scan requested');

  // The UI asks for this variant once a model has been scanned; it used to
  // throw on an out-of-scope variable, leaving the on-screen counts stale.
  const scanned = collectHighlights(holed, { selfIntersections: true });
  equal(scanned.boundaryEdges.length / 2, 4, 'open edges still highlighted');
  assert(Array.isArray(scanned.intersectingFaces), 'intersecting faces returned');

  const flippedIndices = CUBE_INDICES.slice();
  const t = 3 * 3;
  const s = flippedIndices[t + 1]; flippedIndices[t + 1] = flippedIndices[t + 2]; flippedIndices[t + 2] = s;
  const flipped = collectHighlights(new Mesh(new Float64Array(CUBE_POSITIONS), new Uint32Array(flippedIndices)));
  assert(flipped.flippedFaces.length > 0, 'disagreeing faces highlighted');
});

/* --------------------------------------------------- rebuilding as a solid */

/** Union volume of two equal spheres whose centres are `d` apart. */
function unionOfSpheres(radius, d) {
  const whole = 2 * (4 / 3) * Math.PI * radius ** 3;
  const lens = d >= 2 * radius ? 0 : (Math.PI / 12) * (4 * radius + d) * (2 * radius - d) ** 2;
  return whole - lens;
}

test('a rebuilt cube is watertight, manifold and the right size', () => {
  for (const resolution of [32, 64, 128]) {
    const r = rebuildAsSolid(cube(20), { resolution });
    assert(!r.skipped, r.skipped || '');
    const report = analyze(r.mesh, { checkSelfIntersections: true });
    assert(report.watertight, `watertight at ${resolution}`);
    assert(report.manifold, `manifold at ${resolution}`);
    assert(report.oriented, `oriented at ${resolution}`);
    equal(report.shellCount, 1, `one body at ${resolution}`);
    equal(report.selfIntersections.count, 0, `no self-intersections at ${resolution}`);
    const error = Math.abs(report.volume - 8000) / 8000;
    assert(error < 0.01, `volume within 1% at ${resolution} (was ${report.volume.toFixed(1)})`);
  }
});

test('rebuilding merges two overlapping bodies into one solid', () => {
  const radius = 20, distance = 25;
  const source = Cleanup.weldVertices(meshFromTriangles(
    sphereTriangles(40, 40, radius).concat(sphereTriangles(40, 40, radius, [distance, 0, 0])),
  ), 1e-9).mesh;

  const before = analyze(source, { checkSelfIntersections: true });
  equal(before.shellCount, 2, 'starts as two bodies');
  assert(before.selfIntersections.count > 0, 'starts overlapping');

  const r = rebuildAsSolid(source, { resolution: 128 });
  const after = analyze(r.mesh, { checkSelfIntersections: true });
  equal(after.shellCount, 1, 'merged into one body');
  assert(after.watertight, 'watertight');
  assert(after.manifold, 'manifold');
  equal(after.selfIntersections.count, 0, 'no intersections left');

  // The union is genuinely computed, not just glued: the overlap is counted once.
  const expected = unionOfSpheres(radius, distance);
  const error = Math.abs(after.volume - expected) / expected;
  assert(error < 0.02, `union volume within 2% (got ${after.volume.toFixed(0)}, expected ${expected.toFixed(0)})`);
  assert(after.volume < before.volume, 'the overlap is no longer double-counted');
});

test('rebuilding leaves bodies that do not touch as separate bodies', () => {
  const source = meshFromTriangles(
    sphereTriangles(24, 24, 10).concat(sphereTriangles(24, 24, 10, [40, 0, 0])),
  );
  const r = rebuildAsSolid(source, { resolution: 128 });
  const report = analyze(r.mesh);
  equal(report.shellCount, 2, 'still two bodies');
  assert(report.watertight, 'both closed');
});

test('rebuilding resolves a body that passes through itself', () => {
  const positions = [0, 0, 0, 10, 0, 0, 10, 10, 0, 0, 10, 0, 0, 0, 10, 10, 0, 10, -14, -14, -14, 0, 10, 10];
  const broken = new Mesh(new Float64Array(positions), new Uint32Array(CUBE_INDICES));
  assert(analyze(broken, { checkSelfIntersections: true }).selfIntersections.within > 0, 'starts self-intersecting');
  const r = repair(broken, { rebuildAsSolid: true, rebuildResolution: 96 });
  equal(r.after.selfIntersections.count, 0, 'no intersections after rebuilding');
  assert(r.after.watertight && r.after.manifold, 'watertight and manifold');
  assert(r.after.printable, 'printable');
});

test('an inside-out body is turned round before the rebuild reads it', () => {
  // The winding-number test that decides what is solid adds -1 for an
  // inverted shell, cancelling its neighbour and carving out the overlap
  // instead of merging it. The pipeline must orient everything first.
  const upright = sphereTriangles(28, 28, 15);
  const inverted = sphereTriangles(28, 28, 15, [18, 0, 0]).map((t) => [t[0], t[2], t[1]]);
  const source = meshFromTriangles(upright.concat(inverted));

  const r = repair(source, { rebuildAsSolid: true, rebuildResolution: 112 });
  equal(r.after.shellCount, 1, 'merged into one body');
  assert(r.after.watertight, 'watertight');
  const expected = unionOfSpheres(15, 18);
  const error = Math.abs(r.after.volume - expected) / expected;
  assert(error < 0.03, `union volume within 3% (got ${r.after.volume.toFixed(0)}, expected ${expected.toFixed(0)})`);
});

test('a symmetric model does not lose its poles to exact ray hits', () => {
  // A sphere centred on the grid puts ray lines exactly along its own
  // diagonals, straight through shared edges. Counting such a crossing twice
  // flips everything beyond it to solid and opens a hole at the pole.
  for (const resolution of [96, 160, 200, 240]) {
    const source = Cleanup.weldVertices(meshFromTriangles(
      sphereTriangles(48, 48, 20).concat(sphereTriangles(48, 48, 20, [25, 0, 0])),
    ), 1e-9).mesh;
    const r = rebuildAsSolid(source, { resolution });
    const report = analyze(r.mesh);
    equal(report.boundaryEdges, 0, `no open edges at resolution ${resolution}`);
    equal(report.shellCount, 1, `one body at resolution ${resolution}`);
  }
});

test('a rebuild always returns a clean solid, whatever it is given', () => {
  // The whole promise of this mode is that its output needs no further repair.
  // Anything less and it is just a different kind of broken.
  const shapes = [
    ['cube', cube(20)],
    ['unwelded cube soup', cubeSoup(20)],
    ['sphere', sphere(30, 30, 15)],
    ['two overlapping spheres', meshFromTriangles(
      sphereTriangles(32, 32, 15).concat(sphereTriangles(32, 32, 15, [20, 0, 0])))],
    ['two touching spheres', meshFromTriangles(
      sphereTriangles(28, 28, 12).concat(sphereTriangles(28, 28, 12, [24, 0, 0])))],
    ['sphere with a hole punched in it', meshFromTriangles(
      sphereTriangles(30, 30, 15).filter((tri) => (tri[0][0] + tri[1][0] + tri[2][0]) / 3 < 11))],
  ];

  for (const [name, shape] of shapes) {
    for (const resolution of [48, 96, 144]) {
      const r = rebuildAsSolid(shape, { resolution });
      assert(!r.skipped, `${name} @${resolution}: ${r.skipped}`);
      const report = analyze(r.mesh, { checkSelfIntersections: true });
      assert(report.watertight, `${name} @${resolution}: watertight`);
      assert(report.manifold, `${name} @${resolution}: manifold`);
      assert(report.oriented, `${name} @${resolution}: consistently wound`);
      equal(report.degenerate.total, 0, `${name} @${resolution}: no zero-area triangles`);
      equal(report.selfIntersections.count, 0, `${name} @${resolution}: no self-intersections`);
      assert(report.volume > 0, `${name} @${resolution}: positive volume`);
      assert(report.printable, `${name} @${resolution}: printable`);
    }
  }
});

test('the grid backs off rather than exhausting memory', () => {
  const plan = planGrid(cube(100), { resolution: 4000 });
  assert(plan.reduced, 'resolution was reduced');
  assert(plan.points <= 48_000_000, `grid stayed within budget (${plan.points})`);
  assert(plan.resolution < 4000, 'reports the resolution it settled on');
});

test('rebuilding runs once, not once per pass', () => {
  const r = repair(cubeSoup(20), { rebuildAsSolid: true, rebuildResolution: 64, passes: 3 });
  const rebuilds = r.log.filter((e) => e.step === 'Rebuild as a solid' && e.changed);
  equal(rebuilds.length, 1, 'exactly one rebuild');
});

test('rebuilding is off unless asked for', () => {
  const r = repair(cubeSoup(20), {});
  equal(r.log.filter((e) => e.step === 'Rebuild as a solid').length, 0, 'no rebuild step ran');
  equal(r.after.triangles, 12, 'the original triangles are untouched');
});

/* ------------------------------------------------------------------ files */

test('every export format survives a round trip', () => {
  const m = cube();
  m.name = 'cube';
  for (const [format, spec] of Object.entries(EXPORT_FORMATS)) {
    const data = exportMeshes([m], format, { name: 'cube' });
    const buffer = data instanceof ArrayBuffer ? data : new TextEncoder().encode(data).buffer;
    const back = loadFile(`round-trip${spec.extension}`, buffer);
    equal(back.meshes[0].triangleCount, 12, `${format} triangle count`);
    close(back.meshes[0].signedVolume(), 1, 1e-5, `${format} volume`);
  }
});

test('format is detected from content when the extension is missing', () => {
  const m = cube();
  equal(loadFile('mystery', exportMeshes([m], 'stl', {})).format, 'STL (binary)');
  equal(loadFile('mystery', exportMeshes([m], '3mf', {})).format, '3MF');
  const obj = new TextEncoder().encode(exportMeshes([m], 'obj', {})).buffer;
  equal(loadFile('mystery', obj).format, 'OBJ');
});

test('OBJ n-gons and negative indices', () => {
  const r = loadFile('x.obj', new TextEncoder().encode(
    'v 0 0 0\nv 1 0 0\nv 1 1 0\nv 0 1 0\nf 1 2 3 4\nf -4 -3 -2\n').buffer);
  equal(r.meshes[0].triangleCount, 3);
});

test('3MF component transforms are baked into the instance', () => {
  const xml = '<model unit="millimeter"><resources>'
    + '<object id="1" type="model"><mesh><vertices>'
    + '<vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/>'
    + '</vertices><triangles><triangle v1="0" v2="1" v3="2"/></triangles></mesh></object>'
    + '<object id="2" type="model"><components>'
    + '<component objectid="1" transform="1 0 0 0 1 0 0 0 1 10 0 0"/></components></object>'
    + '</resources><build><item objectid="2"/></build></model>';
  const parsed = parseModelXML(xml);
  equal(parsed.objects.size, 2);
  equal(parsed.items.length, 1);
  equal(parsed.unit, 'millimeter');
});

test('an ASCII STL survives a non-ASCII model name', () => {
  // An em dash in the solid name used to make the sniffer call the file binary,
  // and it came back as thousands of nonsense triangles.
  const m = cube();
  m.name = 'Demo — broken sphere';
  const text = exportMeshes([m], 'stl-ascii', { name: m.name });
  const buffer = new TextEncoder().encode(text).buffer;
  const back = loadFile('weird-name.stl', buffer);
  equal(back.format, 'STL (ASCII)', 'detected as ASCII');
  equal(back.meshes[0].triangleCount, 12);
  close(back.meshes[0].signedVolume(), 1, 1e-5);
});

test('a binary STL header with multi-byte characters does not corrupt the count', () => {
  const m = cube();
  const buffer = exportMeshes([m], 'stl', { header: 'Demo — broken sphere — a very long header ' + '—'.repeat(60) });
  const back = loadFile('x.stl', buffer);
  equal(back.format, 'STL (binary)');
  equal(back.meshes[0].triangleCount, 12, 'triangle count intact');
  close(back.meshes[0].signedVolume(), 1, 1e-5);
});

test('a truncated binary STL is read as far as it goes', () => {
  const full = exportMeshes([cube()], 'stl', {});
  const clipped = full.slice(0, 84 + 50 * 5);
  const r = loadFile('clipped.stl', clipped);
  equal(r.meshes[0].triangleCount, 5);
  assert(r.warnings.length > 0, 'warned about the truncation');
});

/* --------------------------------------------------------------- pipeline */

test('a comprehensively broken cube is fully repaired', () => {
  const positions = CUBE_POSITIONS;
  let tris = [];
  for (let t = 0; t < CUBE_INDICES.length; t += 3) {
    tris.push([CUBE_INDICES[t], CUBE_INDICES[t + 1], CUBE_INDICES[t + 2]]);
  }
  tris.splice(8, 1);                                       // a hole
  for (const f of [2, 5]) { const t = tris[f]; tris[f] = [t[0], t[2], t[1]]; }  // flipped
  tris.push(tris[0].slice());                              // duplicate
  tris.push([1, 1, 3]);                                    // degenerate
  const coords = [];
  for (const t of tris) for (const i of t) coords.push(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
  coords.push(5, 5, 5, 5.01, 5, 5, 5, 5.01, 5);            // debris

  const r = repair(Mesh.fromSoup(coords), {});
  assert(r.after.watertight, 'watertight');
  assert(r.after.manifold, 'manifold');
  assert(r.after.oriented, 'consistently wound');
  assert(r.after.printable, 'printable');
  equal(r.after.shellCount, 1, 'one body');
  equal(r.after.triangles, 12, 'back to 12 triangles');
  close(r.after.volume, 1, 1e-9, 'volume');
});

test('repair leaves an already-good model alone', () => {
  const m = cube();
  const r = repair(m, {});
  equal(r.after.triangles, 12);
  close(r.after.volume, 1, 1e-12);
  equal(r.log.filter((e) => e.changed).length, 0, 'nothing reported as changed');
});

test('a punctured sphere is closed with the right volume', () => {
  const tris = sphereTriangles(40, 40, 25);
  const random = rng(7);
  const kept = tris.filter(() => random() > 0.01);
  const r = repair(meshFromTriangles(kept), {});
  assert(r.before.holes > 0, 'started with holes');
  assert(r.after.watertight, 'watertight afterwards');
  equal(r.after.holes, 0, 'no holes left');
  const ideal = (4 / 3) * Math.PI * 25 ** 3;
  assert(Math.abs(r.after.volume - ideal) / ideal < 0.02, `volume within 2% (${r.after.volume} vs ${ideal})`);
});

test('an inside-out model is detected and corrected', () => {
  const m = cube().flipAll();
  const before = analyze(m);
  assert(before.problems.some((p) => p.id === 'inverted'), 'reported as inside-out');
  const r = repair(m, {});
  close(r.after.volume, 1, 1e-12);
  assert(r.after.printable, 'printable after repair');
});

test('a mesh with no defects reports none', () => {
  const report = analyze(cube(), { checkSelfIntersections: true });
  equal(report.problems.length, 0);
  assert(report.printable);
  equal(report.genus, 0, 'a cube has genus 0');
  equal(report.euler, 2, 'Euler characteristic');
});

test('genus is reported for a torus', () => {
  const grid = [];
  const R = 30, r = 10, N = 40, M = 20;
  for (let i = 0; i < N; i++) {
    const u = (i / N) * Math.PI * 2;
    const row = [];
    for (let j = 0; j < M; j++) {
      const v = (j / M) * Math.PI * 2;
      row.push([(R + r * Math.cos(v)) * Math.cos(u), (R + r * Math.cos(v)) * Math.sin(u), r * Math.sin(v)]);
    }
    grid.push(row);
  }
  const tris = [];
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < M; j++) {
      const i2 = (i + 1) % N, j2 = (j + 1) % M;
      tris.push([grid[i][j], grid[i2][j], grid[i2][j2]]);
      tris.push([grid[i][j], grid[i2][j2], grid[i][j2]]);
    }
  }
  const m = Cleanup.weldVertices(meshFromTriangles(tris), 1e-9).mesh;
  const report = analyze(m);
  assert(report.watertight, 'watertight');
  equal(report.genus, 1, 'a torus has genus 1');
});

test('big meshes do not blow the stack', () => {
  const tris = sphereTriangles(120, 120, 50);
  const random = rng(99);
  const kept = tris.filter(() => random() > 0.004);   // thousands of separate holes
  const m = meshFromTriangles(kept);
  assert(m.triangleCount > 25000, 'large enough to matter');
  const r = repair(m, {});
  assert(r.after.watertight, 'watertight');
  assert(r.after.triangles > 0);
});

/* ------------------------------------------------------------------ report */

console.log('\n');
for (const { name, error } of failures) {
  console.log(`FAILED: ${name}\n        ${error.message}`);
}
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
