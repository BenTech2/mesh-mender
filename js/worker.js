/**
 * All geometry work happens here.
 *
 * Repairing a few hundred thousand triangles takes seconds, and on the main
 * thread that means a frozen page and a browser offering to kill the tab. The
 * worker owns the authoritative meshes; the page only ever holds render buffers
 * and numbers.
 */
import { Mesh } from './mesh/core.js';
import { analyze, collectHighlights } from './mesh/analyze.js';
import { repair } from './mesh/repair.js';
import { separateShells } from './mesh/shells.js';
import { layFlatTransform } from './mesh/layflat.js';
import { splitByPlane, AXIS_NAMES } from './mesh/split.js';
import { loadFile, exportMeshes } from './io/index.js';

const models = new Map();   // id -> { mesh, name, format }
let nextId = 1;
const HISTORY_LIMIT = 16;

/**
 * One undo stack for everything.
 *
 * Editing a mesh and splitting one in two are different shapes of change — the
 * first replaces a model's geometry, the second swaps one model for two — but
 * they share an order, and a per-model history cannot express "undo the split".
 * Recording both kinds on one stack means Undo always reverses whatever
 * actually happened last.
 */
const undoStack = [];
const redoStack = [];

function record(step) {
  undoStack.push(step);
  if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
  redoStack.length = 0;
}

function historyState() {
  return { canUndo: undoStack.length > 0, canRedo: redoStack.length > 0 };
}

function store(mesh, name, format) {
  const id = `m${nextId++}`;
  models.set(id, { mesh, name: name || mesh.name || 'model', format });
  return id;
}

/** Replace one model's geometry, remembering what it was. */
function commit(id, mesh) {
  const entry = models.get(id);
  record({ kind: 'mesh', id, before: entry.mesh, after: mesh });
  entry.mesh = mesh;
}

/** Swap models in and out as one reversible step. */
function restructure(removeIds, additions) {
  const removed = removeIds
    .filter((id) => models.has(id))
    .map((id) => ({ id, entry: models.get(id) }));
  for (const { id } of removed) models.delete(id);
  const added = [];
  for (const { mesh, name, format } of additions) {
    added.push(store(mesh, name, format));
  }
  record({ kind: 'structural', removed, added });
  return added;
}

/** Everything the page needs to redraw after a structural change. */
function structuralPayload(removedIds, addedIds) {
  const models_ = addedIds.map((id) => summary(id));
  return {
    payload: {
      removed: removedIds,
      models: models_.map((s) => s.payload),
      history: historyState(),
    },
    transfer: models_.flatMap((s) => s.transfer),
  };
}

function summary(id) {
  const entry = models.get(id);
  const mesh = entry.mesh;
  const buffers = mesh.toRenderBuffers();
  return {
    payload: {
      id,
      name: entry.name,
      format: entry.format,
      unit: mesh.unit,
      triangles: mesh.triangleCount,
      vertices: mesh.vertexCount,
      bounds: mesh.bounds(),
      buffers,
    },
    transfer: [buffers.position.buffer, buffers.normal.buffer],
  };
}

/** Line segments and triangle patches for the viewer's highlight overlays. */
function highlightBuffers(mesh, options) {
  const h = collectHighlights(mesh, options);
  const p = mesh.positions;

  const segments = (pairs) => {
    const out = new Float32Array(pairs.length * 3);
    for (let i = 0; i < pairs.length; i++) {
      const v = pairs[i] * 3;
      out[i * 3] = p[v]; out[i * 3 + 1] = p[v + 1]; out[i * 3 + 2] = p[v + 2];
    }
    return out;
  };
  const faces = (list) => {
    const out = new Float32Array(list.length * 9);
    for (let i = 0; i < list.length; i++) {
      const t = list[i] * 3;
      for (let k = 0; k < 3; k++) {
        const v = mesh.indices[t + k] * 3;
        out[i * 9 + k * 3] = p[v];
        out[i * 9 + k * 3 + 1] = p[v + 1];
        out[i * 9 + k * 3 + 2] = p[v + 2];
      }
    }
    return out;
  };

  return {
    boundary: segments(h.boundaryEdges),
    nonManifold: segments(h.nonManifoldEdges),
    flipped: faces(h.flippedFaces),
    intersecting: faces(h.intersectingFaces),
  };
}


/**
 * A deliberately broken model, so the repair tools can be tried without
 * hunting for a bad STL. It carries one of everything: unwelded vertices, a
 * missing patch, reversed faces, a duplicate, a zero-area triangle, a floating
 * speck, and a small lump passing through the surface.
 */
function buildDemoMesh() {
  const radius = 30, rings = 18, segments = 28;
  const grid = [];
  for (let r = 0; r <= rings; r++) {
    const phi = (r / rings) * Math.PI;
    const row = [];
    for (let s = 0; s < segments; s++) {
      const theta = (s / segments) * Math.PI * 2;
      row.push([
        radius * Math.sin(phi) * Math.cos(theta),
        radius * Math.sin(phi) * Math.sin(theta),
        radius * Math.cos(phi) + radius + 2,
      ]);
    }
    grid.push(row);
  }

  const triangles = [];
  for (let r = 0; r < rings; r++) {
    for (let s = 0; s < segments; s++) {
      const s2 = (s + 1) % segments;
      const a = grid[r][s], b = grid[r][s2], c = grid[r + 1][s2], d = grid[r + 1][s];
      if (r !== 0) triangles.push([a, c, b]);
      if (r !== rings - 1) triangles.push([a, d, c]);
    }
  }

  // Knock a patch out of the side: a hole with a ragged rim.
  const keep = triangles.filter((t) => {
    const cx = (t[0][0] + t[1][0] + t[2][0]) / 3;
    const cy = (t[0][1] + t[1][1] + t[2][1]) / 3;
    const cz = (t[0][2] + t[1][2] + t[2][2]) / 3;
    return !(cx > 14 && cy > -12 && cy < 12 && cz > 20 && cz < 44);
  });

  // Reverse a band of faces so neighbours disagree about which way is out.
  for (let i = 40; i < 64 && i < keep.length; i++) {
    const t = keep[i];
    keep[i] = [t[0], t[2], t[1]];
  }

  keep.push(keep[10].slice());                     // exact duplicate
  keep.push([keep[20][0], keep[20][0], keep[20][1]]); // zero-area triangle

  // A speck of debris floating beside the model.
  const speck = [[46, 26, 12], [49, 26, 12], [47.5, 29, 15]];
  keep.push(speck, [speck[0], speck[2], speck[1]]);

  // A small lump pushed halfway into the sphere: genuine self-intersection.
  const lump = [];
  const lr = 9, lrings = 8, lsegs = 12;
  const centre = [-24, 0, 30];
  const lgrid = [];
  for (let r = 0; r <= lrings; r++) {
    const phi = (r / lrings) * Math.PI;
    const row = [];
    for (let s = 0; s < lsegs; s++) {
      const theta = (s / lsegs) * Math.PI * 2;
      row.push([
        centre[0] + lr * Math.sin(phi) * Math.cos(theta),
        centre[1] + lr * Math.sin(phi) * Math.sin(theta),
        centre[2] + lr * Math.cos(phi),
      ]);
    }
    lgrid.push(row);
  }
  for (let r = 0; r < lrings; r++) {
    for (let s = 0; s < lsegs; s++) {
      const s2 = (s + 1) % lsegs;
      // Left wound inwards deliberately: an inside-out body is one of the
      // defects this demo is meant to show.
      const a = lgrid[r][s], b = lgrid[r][s2], c = lgrid[r + 1][s2], d = lgrid[r + 1][s];
      if (r !== 0) lump.push([a, b, c]);
      if (r !== lrings - 1) lump.push([a, c, d]);
    }
  }

  // Emit as a triangle soup: every corner its own vertex, exactly as an STL would.
  const coords = [];
  for (const t of keep.concat(lump)) {
    for (const v of t) coords.push(v[0], v[1], v[2]);
  }
  const mesh = Mesh.fromSoup(coords);
  mesh.name = 'Demo — broken sphere';
  return mesh;
}

/** Apply a history step in either direction. */
function reverse(step, direction) {
  if (step.kind === 'mesh') {
    const entry = models.get(step.id);
    if (!entry) throw new Error('That model is no longer loaded.');
    entry.mesh = direction === 'undo' ? step.before : step.after;
    const s = summary(step.id);
    return {
      payload: {
        kind: 'mesh', id: step.id, model: s.payload,
        analysis: analyze(entry.mesh), history: historyState(),
      },
      transfer: s.transfer,
    };
  }

  // Structural: undo puts back what was removed and drops what was added;
  // redo does the opposite.
  const takeOut = direction === 'undo' ? step.added : step.removed.map((r) => r.id);
  const putBack = direction === 'undo' ? step.removed : step.addedEntries;

  if (direction === 'undo') {
    step.addedEntries = step.added.map((id) => ({ id, entry: models.get(id) }));
  }
  for (const id of takeOut) models.delete(id);
  for (const { id, entry } of putBack) models.set(id, entry);

  const restored = putBack.map(({ id }) => summary(id));
  return {
    payload: {
      kind: 'structural', removed: takeOut,
      models: restored.map((r) => r.payload), history: historyState(),
    },
    transfer: restored.flatMap((r) => r.transfer),
  };
}

const handlers = {
  load({ filename, buffer }) {
    const result = loadFile(filename, buffer);
    const out = [];
    for (const mesh of result.meshes) {
      const id = store(mesh, mesh.name || filename, result.format);
      const s = summary(id);
      out.push(s.payload);
    }
    return {
      payload: { models: out, format: result.format, warnings: result.warnings || [] },
      transfer: out.flatMap((m) => [m.buffers.position.buffer, m.buffers.normal.buffer]),
    };
  },

  analyze({ id, checkSelfIntersections }) {
    const entry = models.get(id);
    if (!entry) throw new Error('That model is no longer loaded.');
    return { payload: { id, analysis: analyze(entry.mesh, { checkSelfIntersections }) } };
  },

  repair({ id, options }, report) {
    const entry = models.get(id);
    if (!entry) throw new Error('That model is no longer loaded.');
    const result = repair(entry.mesh, options, (fraction, label) => report(fraction, label));
    commit(id, result.mesh);
    const s = summary(id);
    return {
      payload: {
        id, model: s.payload, history: historyState(),
        before: result.before, after: result.after, log: result.log, tolerance: result.tolerance,
      },
      transfer: s.transfer,
    };
  },

  highlights({ id, selfIntersections }) {
    const entry = models.get(id);
    if (!entry) throw new Error('That model is no longer loaded.');
    const buffers = highlightBuffers(entry.mesh, { selfIntersections });
    return {
      payload: { id, buffers },
      transfer: Object.values(buffers).map((b) => b.buffer),
    };
  },

  transform({ id, matrix }) {
    const entry = models.get(id);
    if (!entry) throw new Error('That model is no longer loaded.');
    const next = entry.mesh.clone().applyMatrix4(matrix);
    commit(id, next);
    const s = summary(id);
    return { payload: { id, model: s.payload, history: historyState() }, transfer: s.transfer };
  },

  /**
   * Turn a model onto one of the faces it can actually rest on, and set it down.
   * `index` walks through the alternatives, best first.
   */
  layflat({ id, index }) {
    const entry = models.get(id);
    if (!entry) throw new Error('That model is no longer loaded.');
    const result = layFlatTransform(entry.mesh, index || 0);
    if (!result) {
      return { payload: { id, applied: false, reason: 'This model is flat or has no volume to stand on.' } };
    }
    const next = entry.mesh.clone().applyMatrix4(result.matrix);
    commit(id, next);
    const s = summary(id);
    return {
      payload: {
        id, model: s.payload, applied: true, history: historyState(),
        contactArea: result.candidate.contactArea,
        stable: result.candidate.stable,
        height: result.candidate.height,
        candidates: result.candidates.length,
        index: (index || 0) % result.candidates.length,
      },
      transfer: s.transfer,
    };
  },

  /** Cut a model in two along a plane, capping both halves. */
  split({ id, axis, position }) {
    const entry = models.get(id);
    if (!entry) throw new Error('That model is no longer loaded.');
    const result = splitByPlane(entry.mesh, axis, position);
    if (!result.below.triangleCount || !result.above.triangleCount) {
      return {
        payload: {
          id, applied: false,
          reason: `The ${AXIS_NAMES[axis]} plane at ${position.toFixed(2)} does not pass through the model.`,
        },
      };
    }
    const added = restructure([id], [
      { mesh: result.below, name: result.below.name, format: entry.format },
      { mesh: result.above, name: result.above.name, format: entry.format },
    ]);
    const s = structuralPayload([id], added);
    s.payload.applied = true;
    s.payload.axis = axis;
    s.payload.position = position;
    s.payload.crossSectionArea = result.crossSectionArea;
    s.payload.leftOpen = result.leftOpen;
    return s;
  },

  separate({ id }) {
    const entry = models.get(id);
    if (!entry) throw new Error('That model is no longer loaded.');
    const parts = separateShells(entry.mesh);
    if (parts.length < 2) return { payload: { models: [], reason: 'This model is a single connected body.' } };
    const added = restructure([id], parts.map((mesh) => ({ mesh, name: mesh.name, format: entry.format })));
    return structuralPayload([id], added);
  },

  undo() {
    const step = undoStack.pop();
    if (!step) throw new Error('Nothing to undo.');
    redoStack.push(step);
    return reverse(step, 'undo');
  },

  redo() {
    const step = redoStack.pop();
    if (!step) throw new Error('Nothing to redo.');
    undoStack.push(step);
    return reverse(step, 'redo');
  },

  export({ ids, format, options }) {
    const list = ids.map((id) => models.get(id)).filter(Boolean).map((e) => e.mesh);
    if (!list.length) throw new Error('Nothing to export.');
    const data = exportMeshes(list, format, options || {});
    const transfer = data instanceof ArrayBuffer ? [data] : [];
    return { payload: { data, format }, transfer };
  },

  demo() {
    const mesh = buildDemoMesh();
    const id = store(mesh, mesh.name, 'demo');
    const s = summary(id);
    return { payload: { models: [s.payload] }, transfer: s.transfer };
  },

  remove({ id }) {
    models.delete(id);
    // Deliberately not recorded: closing a model is housekeeping, and leaving
    // it on the undo stack would mean Undo reopens something the user shut.
    return { payload: { id, history: historyState() } };
  },
};

self.onmessage = async (event) => {
  const { id: requestId, type, payload } = event.data;
  const report = (fraction, label) => {
    self.postMessage({ requestId, kind: 'progress', fraction, label });
  };
  try {
    const handler = handlers[type];
    if (!handler) throw new Error(`Unknown request: ${type}`);
    const result = await handler(payload || {}, report);
    self.postMessage(
      { requestId, kind: 'result', payload: result.payload },
      result.transfer || [],
    );
  } catch (error) {
    self.postMessage({
      requestId, kind: 'error',
      message: error && error.message ? error.message : String(error),
      stack: error && error.stack,
    });
  }
};

self.postMessage({ kind: 'ready' });
