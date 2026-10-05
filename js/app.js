/**
 * UI layer. Holds no geometry of its own: the worker owns the meshes, this file
 * owns the DOM, and the only things crossing between them are render buffers
 * and plain numbers.
 */
import { Viewer } from './viewer.js';

/* ------------------------------------------------------------------ worker */

class WorkerClient {
  constructor(url) {
    this.worker = new Worker(url, { type: 'module' });
    this.pending = new Map();
    this.nextId = 1;
    this.worker.onmessage = (event) => {
      const { requestId, kind } = event.data;
      const entry = this.pending.get(requestId);
      if (!entry) return;
      if (kind === 'progress') { entry.onProgress?.(event.data.fraction, event.data.label); return; }
      this.pending.delete(requestId);
      if (kind === 'error') {
        const error = new Error(event.data.message);
        error.workerStack = event.data.stack;
        entry.reject(error);
      } else {
        entry.resolve(event.data.payload);
      }
    };
    this.worker.onerror = (event) => {
      console.error('Worker failed', event);
      toast('error', 'The repair engine crashed. Check the browser console.');
    };
  }

  request(type, payload, { transfer = [], onProgress } = {}) {
    const requestId = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject, onProgress });
      this.worker.postMessage({ id: requestId, type, payload }, transfer);
    });
  }
}

/* ------------------------------------------------------------------- state */

const state = {
  models: new Map(),
  selectedId: null,
  busyDepth: 0,
  // Undo is a single stack in the worker, covering edits and splits alike.
  history: { canUndo: false, canRedo: false },
  layFlatIndex: 0,
  split: { axis: 2, position: null },
};

/** Every mutating reply carries the history state; keep the buttons in step. */
function noteHistory(payload) {
  if (payload && payload.history) state.history = payload.history;
  $('undo-button').disabled = !state.history.canUndo;
  $('redo-button').disabled = !state.history.canRedo;
}

const worker = new WorkerClient(new URL('./worker.js', import.meta.url));
const viewer = new Viewer(document.getElementById('canvas'));
window.__viewer = viewer; // handy from the console when something looks wrong

const $ = (id) => document.getElementById(id);
const el = {
  fileInput: $('file-input'),
  dropzone: $('dropzone'),
  modelList: $('model-list'),
  modelEmpty: $('model-empty'),
  legend: $('legend'),
  busy: $('busy'),
  busyLabel: $('busy-label'),
  busyBar: $('busy-bar'),
  verdict: $('verdict'),
  problemList: $('problem-list'),
  compareTable: $('compare-table'),
  repairLog: $('repair-log'),
  statsFacts: $('stats-facts'),
  sizeFacts: $('size-facts'),
  toasts: $('toasts'),
};

/* --------------------------------------------------------------- utilities */

function toast(kind, message, ms = 5200) {
  const node = document.createElement('div');
  node.className = `toast ${kind}`;
  node.textContent = message;
  el.toasts.append(node);
  setTimeout(() => {
    node.style.transition = 'opacity .3s';
    node.style.opacity = '0';
    setTimeout(() => node.remove(), 300);
  }, ms);
}

function busy(on, label = 'Working…') {
  state.busyDepth += on ? 1 : -1;
  if (state.busyDepth < 0) state.busyDepth = 0;
  el.busy.hidden = state.busyDepth === 0;
  if (on) {
    el.busyLabel.textContent = label;
    el.busyBar.style.width = '0%';
  }
}

function progress(fraction, label) {
  el.busyBar.style.width = `${Math.round(Math.max(0, Math.min(1, fraction)) * 100)}%`;
  if (label) el.busyLabel.textContent = label;
}

const nf = new Intl.NumberFormat();
const count = (n) => nf.format(n);

function dimension(mm) {
  if (!Number.isFinite(mm)) return '—';
  const abs = Math.abs(mm);
  // Rotating a model leaves its resting height at something like 4e-15 rather
  // than 0. That is zero for every purpose anyone has here, and printing it in
  // scientific notation just looks like a fault.
  if (abs < 1e-6) return '0.00 mm';
  if (abs >= 1000) return `${(mm / 10).toFixed(1)} cm`;
  if (abs >= 1) return `${mm.toFixed(2)} mm`;
  return `${mm.toPrecision(3)} mm`;
}

function volume(mm3) {
  if (!Number.isFinite(mm3)) return '—';
  const abs = Math.abs(mm3);
  if (abs >= 1000) return `${(mm3 / 1000).toFixed(2)} cm³`;
  return `${mm3.toFixed(2)} mm³`;
}

const UNIT_TO_MM = {
  millimeter: 1, centimeter: 10, inch: 25.4, meter: 1000, micron: 0.001, foot: 304.8,
};

/* ------------------------------------------------------- model bookkeeping */

function selected() {
  return state.selectedId ? state.models.get(state.selectedId) : null;
}

function adoptModel(payload) {
  const existing = state.models.get(payload.id) || {};
  const model = { ...existing, ...payload };
  delete model.buffers;
  state.models.set(payload.id, model);
  viewer.updateModel(payload.id, payload.buffers);
  return model;
}

function renderModelList() {
  el.modelList.replaceChildren();
  el.modelEmpty.hidden = state.models.size > 0;

  for (const model of state.models.values()) {
    const li = document.createElement('li');
    li.className = 'model-item';
    if (model.id === state.selectedId) li.classList.add('selected');
    if (model.visible === false) li.classList.add('hidden-model');

    const eye = document.createElement('button');
    eye.className = 'eye';
    eye.type = 'button';
    eye.textContent = model.visible === false ? '○' : '●';
    eye.title = model.visible === false ? 'Show' : 'Hide';
    eye.addEventListener('click', (event) => {
      event.stopPropagation();
      model.visible = model.visible === false;
      viewer.setModelVisible(model.id, model.visible);
      renderModelList();
    });

    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = model.name || 'model';
    name.title = `${model.name} — ${model.format || ''}`;

    const counter = document.createElement('span');
    counter.className = 'count';
    counter.textContent = count(model.triangles);

    const close = document.createElement('button');
    close.className = 'close';
    close.type = 'button';
    close.textContent = '×';
    close.title = 'Remove';
    close.addEventListener('click', async (event) => {
      event.stopPropagation();
      await worker.request('remove', { id: model.id });
      viewer.removeModel(model.id);
      state.models.delete(model.id);
      if (state.selectedId === model.id) {
        state.selectedId = state.models.keys().next().value || null;
      }
      renderModelList();
      refreshSelection();
    });

    li.append(eye, name, counter, close);
    li.title = 'Select this part and bring it into view';
    li.addEventListener('click', () => selectModel(model.id, { frame: true }));
    el.modelList.append(li);
  }
}

/**
 * @param {string} id
 * @param {{frame?: boolean}} opts `frame` moves the camera to the part. Only
 *   set when the choice was the user's: framing on every repair, undo or reload
 *   would yank the view around while they were reading the result.
 */
async function selectModel(id, { frame = false } = {}) {
  if (id !== state.selectedId) {
    // The cut position and the lay-flat sequence belong to the model they were
    // set on; carrying them to another one aims the saw somewhere arbitrary.
    state.split.position = null;
    state.layFlatIndex = 0;
    $('layflat-note').hidden = true;
  }
  state.selectedId = id;
  renderModelList();
  if (frame) viewer.frameModel(id);
  await refreshSelection();
}

async function refreshSelection() {
  const model = selected();
  const has = Boolean(model);
  $('diagnosis-section').hidden = !has;
  $('repair-section').hidden = !has;
  $('stats-section').hidden = !has;
  $('transform-section').hidden = !has;
  $('export-button').disabled = !has;
  el.legend.hidden = !has;
  $('separate-button').hidden = !model || (model.analysis?.shellCount ?? 1) < 2;

  // The rebuild is always on offer once a model is loaded. Revealing it only
  // once an intersection scan had found something meant that on a fresh load
  // neither this button nor its checkbox — folded away inside the individual
  // fixes — was visible at all, and a mode nobody can find may as well not
  // exist. The wording changes to match what the model actually needs.
  const intersections = model?.analysis?.selfIntersections;
  const crossing = Boolean(intersections && (intersections.within > 0 || intersections.between > 0));
  $('rebuild-button').hidden = !model;
  $('rebuild-offer').hidden = !model;
  $('rebuild-offer').textContent = crossing
    ? 'Walls passing through each other cannot be fixed by editing the surface. Rebuilding '
      + 're-derives it from scratch, which resolves them and merges overlapping bodies — at the '
      + 'cost of resampling every detail.'
    : 'Re-derives the surface from scratch. The heavy option: it always returns a watertight, '
      + 'manifold solid, and merges overlapping bodies — but it resamples every detail, so edges '
      + 'soften and the triangle count climbs steeply.';
  noteHistory(null);
  $('split-section').hidden = !has;
  $('report-section').hidden = !model?.lastReport;

  viewer.setSelected(state.selectedId);
  if (!model) { viewer.hideCutPlane(); return; }
  if (!model.analysis) {
    await analyseModel(model.id, false);
    return;
  }
  renderDiagnosis(model.analysis);
  renderStats(model);
  updateRebuildHint();
  refreshSplitControls();
  if (model.lastReport) renderReport(model.lastReport);
  $('unit-select').value = UNIT_TO_MM[model.unit] ? model.unit : 'millimeter';
  await refreshHighlights();
}

/* ------------------------------------------------------------- diagnostics */

async function analyseModel(id, checkSelfIntersections) {
  busy(true, 'Inspecting the mesh…');
  try {
    const result = await worker.request('analyze', { id, checkSelfIntersections });
    const model = state.models.get(id);
    model.analysis = result.analysis;
    renderDiagnosis(result.analysis);
    renderStats(model);
    await refreshHighlights();
  } catch (error) {
    toast('error', error.message);
  } finally {
    busy(false);
  }
}

function renderDiagnosis(analysis) {
  const critical = analysis.problems.filter((p) => p.severity === 'critical').length;
  const warnings = analysis.problems.filter((p) => p.severity === 'warning').length;

  const dot = document.createElement('span');
  dot.className = 'dot';
  const text = document.createElement('span');

  el.verdict.className = 'verdict';
  if (critical > 0) {
    el.verdict.classList.add('bad');
    text.textContent = `Not ready to print — ${critical} serious problem${critical === 1 ? '' : 's'}`;
  } else if (warnings > 0) {
    el.verdict.classList.add('warn');
    text.textContent = `Printable, with ${warnings} thing${warnings === 1 ? '' : 's'} worth fixing`;
  } else {
    el.verdict.classList.add('ok');
    text.textContent = 'Watertight, manifold and correctly wound';
  }
  el.verdict.replaceChildren(dot, text);

  el.problemList.replaceChildren();
  if (analysis.problems.length === 0) {
    const li = document.createElement('li');
    li.className = 'problem info';
    li.innerHTML = '<div class="label">No defects found</div><div class="detail">This model should slice cleanly.</div>';
    el.problemList.append(li);
  }
  for (const problem of analysis.problems) {
    const li = document.createElement('li');
    li.className = `problem ${problem.severity}`;
    const label = document.createElement('div');
    label.className = 'label';
    label.textContent = problem.label;
    const detail = document.createElement('div');
    detail.className = 'detail';
    detail.textContent = problem.detail;
    li.append(label, detail);
    el.problemList.append(li);
  }

  $('scan-intersections').hidden = analysis.selfIntersections != null;
}

function renderStats(model) {
  const a = model.analysis;
  if (!a) return;
  const rows = [
    ['Triangles', count(a.triangles)],
    ['Vertices', count(a.vertices)],
    ['Separate bodies', count(a.shellCount)],
    ['Open edges', count(a.boundaryEdges)],
    ['Holes', count(a.holes)],
    ['Surface area', `${(a.area / 100).toFixed(2)} cm²`],
    ['Volume', volume(a.volume)],
    ['Watertight', a.watertight ? 'yes' : 'no'],
  ];
  if (a.genus != null) rows.push(['Genus', String(a.genus)]);
  el.statsFacts.replaceChildren(...rows.flatMap(([k, v]) => {
    const dt = document.createElement('dt'); dt.textContent = k;
    const dd = document.createElement('dd'); dd.textContent = v;
    return [dt, dd];
  }));

  const b = a.bounds;
  const sizeRows = [
    ['Width (X)', dimension(b.size[0])],
    ['Depth (Y)', dimension(b.size[1])],
    ['Height (Z)', dimension(b.size[2])],
    ['Sits at Z', dimension(b.min[2])],
  ];
  el.sizeFacts.replaceChildren(...sizeRows.flatMap(([k, v]) => {
    const dt = document.createElement('dt'); dt.textContent = k;
    const dd = document.createElement('dd'); dd.textContent = v;
    return [dt, dd];
  }));
}

async function refreshHighlights() {
  const model = selected();
  if (!model) return;
  try {
    const wantIntersections = model.analysis?.selfIntersections != null;
    const result = await worker.request('highlights', {
      id: model.id, selfIntersections: wantIntersections,
    });
    viewer.setHighlights(model.id, result.buffers);
    $('count-boundary').textContent = count(result.buffers.boundary.length / 6);
    $('count-nonmanifold').textContent = count(result.buffers.nonManifold.length / 6);
    $('count-flipped').textContent = count(result.buffers.flipped.length / 9);
    $('count-intersecting').textContent = wantIntersections
      ? count(result.buffers.intersecting.length / 9) : '–';
  } catch (error) {
    // Worth surfacing: stale highlight counts look like a wrong diagnosis.
    console.error(error);
    toast('error', `Could not draw the problem overlay: ${error.message}`);
    for (const key of ['boundary', 'nonmanifold', 'flipped', 'intersecting']) {
      $(`count-${key}`).textContent = '?';
    }
  }
}

/* ------------------------------------------------------------------ repair */

function readOptions() {
  const options = {};
  for (const input of document.querySelectorAll('[data-option]')) {
    options[input.dataset.option] = input.checked;
  }
  const tolerance = $('tolerance-input').value.trim();
  options.weldTolerance = tolerance === '' ? 'auto' : Number(tolerance);
  if (Number.isNaN(options.weldTolerance)) options.weldTolerance = 'auto';
  options.rebuildResolution = Number($('rebuild-resolution').value) || 160;
  return options;
}

/** Show what the chosen detail level works out to for this model. */
function updateRebuildHint() {
  const model = selected();
  const hint = $('rebuild-hint');
  const base = 'Re-derives the surface from scratch instead of editing it. Fixes intersections that '
    + 'cannot be edited away, and merges overlapping bodies into one solid. Every detail is '
    + 'resampled, so sharp edges soften and the triangle count goes up a lot.';
  if (!model?.analysis) { hint.textContent = base; return; }
  const size = model.analysis.bounds.size;
  const longest = Math.max(size[0], size[1], size[2]);
  const resolution = Number($('rebuild-resolution').value) || 160;
  const voxel = longest / resolution;
  hint.textContent = `${base} At this setting the model is sampled about every ${dimension(voxel)}, `
    + 'so anything finer than that disappears.';
}

async function runRepair(overrides = {}) {
  const model = selected();
  if (!model) return;
  busy(true, overrides.rebuildAsSolid ? 'Rebuilding as a solid…' : 'Repairing…');
  try {
    const result = await worker.request(
      'repair',
      { id: model.id, options: { ...readOptions(), ...overrides } },
      { onProgress: (fraction, label) => progress(fraction, label) },
    );
    const updated = adoptModel(result.model);
    updated.analysis = result.after;
    updated.lastReport = { before: result.before, after: result.after, log: result.log };
    noteHistory(result);
    state.layFlatIndex = 0;
    renderModelList();
    await refreshSelection();

    const fixed = result.before.problems.length - result.after.problems.length;
    if (result.after.printable) {
      toast('success', 'Repaired: the model is now watertight, manifold and correctly wound.');
    } else if (fixed > 0) {
      toast('info', `Fixed ${fixed} problem${fixed === 1 ? '' : 's'}. ${result.after.problems.length} remain — see the list.`);
    } else {
      toast('info', 'Nothing needed changing.');
    }
  } catch (error) {
    toast('error', `Repair failed: ${error.message}`);
    console.error(error);
  } finally {
    busy(false);
  }
}

function renderReport({ before, after, log }) {
  $('report-section').hidden = false;

  const metrics = [
    ['Triangles', before.triangles, after.triangles, 'neutral'],
    ['Vertices', before.vertices, after.vertices, 'neutral'],
    ['Open edges', before.boundaryEdges, after.boundaryEdges, 'down'],
    ['Holes', before.holes, after.holes, 'down'],
    ['Non-manifold edges', before.nonManifoldEdges, after.nonManifoldEdges, 'down'],
    ['Pinched vertices', before.nonManifoldVertices, after.nonManifoldVertices, 'down'],
    ['Flipped edges', before.inconsistentEdges, after.inconsistentEdges, 'down'],
    ['Zero-area faces', before.degenerate.total, after.degenerate.total, 'down'],
    ['Duplicate faces', before.duplicates.total, after.duplicates.total, 'down'],
    ['Separate bodies', before.shellCount, after.shellCount, 'down'],
  ];
  if (before.selfIntersections && after.selfIntersections) {
    metrics.push(['Intersecting pairs', before.selfIntersections.count, after.selfIntersections.count, 'down']);
  }

  const table = el.compareTable;
  table.replaceChildren();
  const thead = document.createElement('thead');
  thead.innerHTML = '<tr><th>Measure</th><th>Before</th><th>After</th></tr>';
  const tbody = document.createElement('tbody');
  for (const [label, a, b, direction] of metrics) {
    if (a === 0 && b === 0 && direction === 'down') continue;
    const tr = document.createElement('tr');
    const td0 = document.createElement('td'); td0.textContent = label;
    const td1 = document.createElement('td'); td1.textContent = count(a);
    const td2 = document.createElement('td'); td2.textContent = count(b);
    if (direction === 'down' && b < a) td2.className = 'better';
    if (direction === 'down' && b > a) td2.className = 'worse';
    tr.append(td0, td1, td2);
    tbody.append(tr);
  }
  const volumeRow = document.createElement('tr');
  volumeRow.innerHTML = `<td>Volume</td><td>${volume(before.volume)}</td><td>${volume(after.volume)}</td>`;
  tbody.append(volumeRow);
  table.append(thead, tbody);

  el.repairLog.replaceChildren();
  for (const entry of log) {
    const li = document.createElement('li');
    if (!entry.changed) li.className = 'idle';
    const strong = document.createElement('strong');
    strong.textContent = `${entry.step}: `;
    li.append(strong, document.createTextNode(entry.message));
    el.repairLog.append(li);
  }
}

/* ------------------------------------------------------------------ files */

async function openFiles(files) {
  for (const file of files) {
    busy(true, `Reading ${file.name}…`);
    try {
      const buffer = await file.arrayBuffer();
      const result = await worker.request(
        'load', { filename: file.name, buffer }, { transfer: [buffer] },
      );
      let firstId = null;
      for (const payload of result.models) {
        const model = adoptModel(payload);
        model.format = result.format;
        model.visible = true;
        if (!firstId) firstId = model.id;
      }
      for (const warning of result.warnings) toast('info', warning);
      el.dropzone.hidden = true;
      renderModelList();
      if (firstId) await selectModel(firstId);
      viewer.frameAll();
      fitPlateToModels();
    } catch (error) {
      toast('error', `${file.name}: ${error.message}`);
      console.error(error);
    } finally {
      busy(false);
    }
  }
}

function fitPlateToModels() {
  let needed = 0;
  for (const model of state.models.values()) {
    if (!model.bounds) continue;
    needed = Math.max(needed, Math.abs(model.bounds.min[0]), Math.abs(model.bounds.max[0]),
                              Math.abs(model.bounds.min[1]), Math.abs(model.bounds.max[1]));
  }
  const size = Math.max(220, Math.ceil((needed * 2.2) / 50) * 50);
  if (size !== viewer.plateSize) {
    viewer.setPlateSize(size);
    $('plate-input').value = size;
  }
}

async function exportSelected() {
  const model = selected();
  if (!model) return;
  const format = $('export-format').value;
  busy(true, 'Writing the file…');
  try {
    const result = await worker.request('export', {
      ids: [model.id], format, options: { name: model.name, unit: model.unit },
    });
    const extensions = { '3mf': '.3mf', stl: '.stl', 'stl-ascii': '.stl', obj: '.obj' };
    const types = { '3mf': 'model/3mf', stl: 'model/stl', 'stl-ascii': 'model/stl', obj: 'text/plain' };
    const blob = new Blob([result.data], { type: types[format] });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    const base = (model.name || 'model').replace(/[\\/:*?"<>|]+/g, '_');
    link.href = url;
    link.download = `${base}-repaired${extensions[format]}`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  } catch (error) {
    toast('error', `Could not save: ${error.message}`);
  } finally {
    busy(false);
  }
}

/** Take in the result of an operation that swapped one model for several. */
function adoptStructural(result, format) {
  noteHistory(result);
  for (const id of result.removed ? [].concat(result.removed) : []) {
    viewer.removeModel(id);
    state.models.delete(id);
  }
  let firstId = null;
  for (const payload of result.models) {
    const part = adoptModel(payload);
    part.format = format;
    part.visible = true;
    if (!firstId) firstId = part.id;
  }
  state.layFlatIndex = 0;
  renderModelList();
  return firstId;
}

/* -------------------------------------------------------------- transforms */

function identity() {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

function rotationMatrix(axis, radians) {
  const c = Math.cos(radians), s = Math.sin(radians);
  const m = identity();
  if (axis === 'x') { m[5] = c; m[6] = s; m[9] = -s; m[10] = c; }
  if (axis === 'y') { m[0] = c; m[2] = -s; m[8] = s; m[10] = c; }
  if (axis === 'z') { m[0] = c; m[1] = s; m[4] = -s; m[5] = c; }
  return m;
}

function scaleMatrix(sx, sy, sz) {
  const m = identity();
  m[0] = sx; m[5] = sy; m[10] = sz;
  return m;
}

function translationMatrix(x, y, z) {
  const m = identity();
  m[12] = x; m[13] = y; m[14] = z;
  return m;
}

async function applyTransform(matrix, label = 'Moving…') {
  const model = selected();
  if (!model) return;
  busy(true, label);
  try {
    const result = await worker.request('transform', { id: model.id, matrix });
    adoptModel(result.model);
    noteHistory(result);
    state.layFlatIndex = 0;
    const fresh = await worker.request('analyze', { id: model.id, checkSelfIntersections: false });
    state.models.get(model.id).analysis = fresh.analysis;
    renderModelList();
    await refreshSelection();
    fitPlateToModels();
  } catch (error) {
    toast('error', error.message);
  } finally {
    busy(false);
  }
}

/* ------------------------------------------------------------- lay flat */

async function runLayFlat() {
  const model = selected();
  if (!model) return;
  busy(true, 'Finding a face to rest on…');
  try {
    const result = await worker.request('layflat', { id: model.id, index: state.layFlatIndex });
    if (!result.applied) { toast('info', result.reason); return; }

    adoptModel(result.model);
    noteHistory(result);
    const fresh = await worker.request('analyze', { id: model.id, checkSelfIntersections: false });
    state.models.get(model.id).analysis = fresh.analysis;
    renderModelList();
    await refreshSelection();
    fitPlateToModels();

    // Keep offering the next-best face: which way up a model "should" go is a
    // judgement, and the largest flat face is a good guess rather than an
    // answer. Pressing again tries the next one down.
    state.layFlatIndex = result.index + 1;

    // A rounded shape has no flat face; it has thousands of tiny ones and rests
    // on whichever it was left touching. Offering to step through 510 of them
    // would be worse than useless, so say what actually happened instead.
    const bounds = state.models.get(model.id).analysis.bounds;
    const footprint = Math.max(bounds.size[0] * bounds.size[1], 1);
    const note = $('layflat-note');
    note.hidden = false;
    if (result.contactArea < footprint * 0.02) {
      note.textContent = 'This shape has no flat face to stand on, so it was set down on the '
        + 'closest thing to one. Press again to try another.';
    } else if (result.candidates > 1) {
      note.textContent = `Resting on a face of ${Math.round(result.contactArea)} mm². `
        + 'Press again to try the next-largest face.';
    } else {
      note.textContent = `Resting on a face of ${Math.round(result.contactArea)} mm².`;
    }
    if (!result.stable) {
      toast('info', 'That is the flattest face available, but the model is top-heavy on it and may topple.');
    }
  } catch (error) {
    toast('error', error.message);
  } finally {
    busy(false);
  }
}

/* ----------------------------------------------------------------- split */

/** The model's extent along the current split axis. */
function splitRange() {
  const model = selected();
  if (!model?.analysis) return null;
  const b = model.analysis.bounds;
  const axis = state.split.axis;
  return { min: b.min[axis], max: b.max[axis], centre: b.center[axis] };
}

function refreshSplitControls({ resetPosition = false } = {}) {
  const range = splitRange();
  const section = $('split-section');
  if (!range) { section.hidden = true; viewer.hideCutPlane(); return; }
  section.hidden = false;

  if (resetPosition || state.split.position === null
      || state.split.position < range.min || state.split.position > range.max) {
    state.split.position = range.centre;
  }

  for (const button of document.querySelectorAll('[data-split-axis]')) {
    button.classList.toggle('selected', Number(button.dataset.splitAxis) === state.split.axis);
  }

  const span = range.max - range.min;
  const slider = $('split-slider');
  slider.value = span > 0 ? String(Math.round(((state.split.position - range.min) / span) * 1000)) : '500';
  $('split-position').value = Number(state.split.position.toFixed(3));
  $('split-position').min = Number(range.min.toFixed(3));
  $('split-position').max = Number(range.max.toFixed(3));

  const model = selected();
  viewer.showCutPlane(state.split.axis, state.split.position, viewer.boundsOfModel(model.id));
}

async function runSplit() {
  const model = selected();
  const range = splitRange();
  if (!model || !range) return;
  if (state.split.position <= range.min || state.split.position >= range.max) {
    toast('info', 'That cut falls outside the model. Move it between the ends.');
    return;
  }
  busy(true, 'Cutting…');
  try {
    const result = await worker.request('split', {
      id: model.id, axis: state.split.axis, position: state.split.position,
    });
    if (!result.applied) { toast('info', result.reason); return; }

    viewer.hideCutPlane();
    const firstId = adoptStructural(result, model.format);
    await selectModel(firstId, { frame: true });
    fitPlateToModels();

    const axisName = ['X', 'Y', 'Z'][result.axis];
    if (result.leftOpen > 0) {
      toast('info', `Cut along ${axisName}, but ${result.leftOpen} edges could not be capped — repair the model and cut again for a closed result.`);
    } else {
      toast('success', `Cut along ${axisName}. Both halves are closed; the cut face is ${(result.crossSectionArea / 100).toFixed(2)} cm².`);
    }
  } catch (error) {
    toast('error', error.message);
  } finally {
    busy(false);
  }
}

/* ------------------------------------------------------------------- wiring */

$('open-button').addEventListener('click', () => el.fileInput.click());
$('dropzone-button').addEventListener('click', () => el.fileInput.click());
el.fileInput.addEventListener('change', () => {
  if (el.fileInput.files.length) openFiles(Array.from(el.fileInput.files));
  el.fileInput.value = '';
});

$('demo-button').addEventListener('click', async () => {
  busy(true, 'Building a test model…');
  try {
    const result = await worker.request('demo', {});
    for (const payload of result.models) {
      const model = adoptModel(payload);
      model.format = 'demo';
      model.visible = true;
      state.selectedId = model.id;
    }
    el.dropzone.hidden = true;
    renderModelList();
    await refreshSelection();
    viewer.frameAll();
  } catch (error) {
    toast('error', error.message);
  } finally {
    busy(false);
  }
});

for (const type of ['dragenter', 'dragover']) {
  document.addEventListener(type, (event) => {
    event.preventDefault();
    el.dropzone.hidden = false;
    el.dropzone.classList.add('dragging');
  });
}
document.addEventListener('dragleave', (event) => {
  if (event.relatedTarget) return;
  el.dropzone.classList.remove('dragging');
  if (state.models.size) el.dropzone.hidden = true;
});
document.addEventListener('drop', (event) => {
  event.preventDefault();
  el.dropzone.classList.remove('dragging');
  if (state.models.size) el.dropzone.hidden = true;
  const files = Array.from(event.dataTransfer?.files || []);
  if (files.length) openFiles(files);
});

$('separate-button').addEventListener('click', async () => {
  const model = selected();
  if (!model) return;
  busy(true, 'Splitting bodies apart…');
  try {
    const result = await worker.request('separate', { id: model.id });
    if (!result.models.length) { toast('info', result.reason); return; }
    const firstId = adoptStructural(result, model.format);
    await selectModel(firstId, { frame: true });
    toast('success', `Split into ${result.models.length} separate bodies. Pick one from the list to bring it into view.`);
  } catch (error) {
    toast('error', error.message);
  } finally {
    busy(false);
  }
});

$('repair-button').addEventListener('click', () => runRepair());

$('rebuild-button').addEventListener('click', () => {
  document.querySelector('[data-option="rebuildAsSolid"]').checked = true;
  $('repair-options').open = true;
  runRepair({ rebuildAsSolid: true });
});

$('rebuild-resolution').addEventListener('change', updateRebuildHint);
$('export-button').addEventListener('click', exportSelected);
$('scan-intersections').addEventListener('click', () => {
  const model = selected();
  if (model) analyseModel(model.id, true);
});

async function stepHistory(direction) {
  try {
    const result = await worker.request(direction, {});
    applyHistoryStep(result);
  } catch (error) {
    toast('info', error.message);
  }
}

/** A history step either restores one model's geometry or swaps models around. */
async function applyHistoryStep(result) {
  noteHistory(result);
  if (result.kind === 'mesh') {
    const model = adoptModel(result.model);
    model.analysis = result.analysis;
    delete model.lastReport;
    state.selectedId = model.id;
  } else {
    for (const id of result.removed) {
      viewer.removeModel(id);
      state.models.delete(id);
    }
    let firstId = null;
    for (const payload of result.models) {
      const model = adoptModel(payload);
      model.visible = true;
      model.analysis = null;
      if (!firstId) firstId = model.id;
    }
    if (!state.models.has(state.selectedId)) {
      state.selectedId = firstId || state.models.keys().next().value || null;
    }
  }
  state.layFlatIndex = 0;
  renderModelList();
  await refreshSelection();
  fitPlateToModels();
}

$('undo-button').addEventListener('click', () => stepHistory('undo'));
$('redo-button').addEventListener('click', () => stepHistory('redo'));

for (const button of document.querySelectorAll('[data-rotate]')) {
  button.addEventListener('click', () => {
    applyTransform(rotationMatrix(button.dataset.rotate, Math.PI / 2), 'Rotating…');
  });
}
for (const button of document.querySelectorAll('[data-mirror]')) {
  button.addEventListener('click', () => {
    const axis = button.dataset.mirror;
    applyTransform(scaleMatrix(axis === 'x' ? -1 : 1, axis === 'y' ? -1 : 1, axis === 'z' ? -1 : 1), 'Mirroring…');
  });
}

$('apply-scale').addEventListener('click', () => {
  const percent = Number($('scale-input').value);
  if (!(percent > 0)) { toast('error', 'Scale must be greater than zero.'); return; }
  applyTransform(scaleMatrix(percent / 100, percent / 100, percent / 100), 'Scaling…');
  $('scale-input').value = '100';
});

$('apply-unit').addEventListener('click', () => {
  const model = selected();
  if (!model) return;
  const from = UNIT_TO_MM[$('unit-select').value] ?? 1;
  const current = UNIT_TO_MM[model.unit] ?? 1;
  const factor = from / current;
  if (factor === 1) { toast('info', 'The model is already in those units.'); return; }
  applyTransform(scaleMatrix(factor, factor, factor), 'Converting units…')
    .then(() => { model.unit = 'millimeter'; });
});

$('layflat-button').addEventListener('click', runLayFlat);

for (const button of document.querySelectorAll('[data-split-axis]')) {
  button.addEventListener('click', () => {
    state.split.axis = Number(button.dataset.splitAxis);
    refreshSplitControls({ resetPosition: true });
  });
}

$('split-slider').addEventListener('input', () => {
  const range = splitRange();
  if (!range) return;
  state.split.position = range.min + ((range.max - range.min) * Number($('split-slider').value)) / 1000;
  refreshSplitControls();
});

$('split-position').addEventListener('change', () => {
  const value = Number($('split-position').value);
  if (Number.isFinite(value)) state.split.position = value;
  refreshSplitControls();
});

$('split-middle').addEventListener('click', () => refreshSplitControls({ resetPosition: true }));
$('split-button').addEventListener('click', runSplit);

$('centre-button').addEventListener('click', () => {
  const model = selected();
  if (!model?.analysis) return;
  const b = model.analysis.bounds;
  applyTransform(translationMatrix(-b.center[0], -b.center[1], 0), 'Centring…');
});

$('drop-button').addEventListener('click', () => {
  const model = selected();
  if (!model?.analysis) return;
  const b = model.analysis.bounds;
  applyTransform(translationMatrix(0, 0, -b.min[2]), 'Dropping to plate…');
});

$('plate-input').addEventListener('change', () => {
  const size = Number($('plate-input').value);
  if (size >= 20) viewer.setPlateSize(size);
});

for (const button of document.querySelectorAll('[data-view]')) {
  button.addEventListener('click', () => viewer.setView(button.dataset.view));
}
$('fit-button').addEventListener('click', () => viewer.frameAll());
$('toggle-ghost').addEventListener('change', (e) => viewer.setGhostUnselected(e.target.checked));
$('toggle-wireframe').addEventListener('change', (e) => viewer.setWireframe(e.target.checked));
$('toggle-backfaces').addEventListener('change', (e) => viewer.setBackfaceHighlight(e.target.checked));

for (const input of document.querySelectorAll('[data-highlight]')) {
  input.addEventListener('change', () => viewer.setHighlightVisible(input.dataset.highlight, input.checked));
}

document.addEventListener('keydown', (event) => {
  const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(event.target.tagName);
  if (typing) return;
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
    event.preventDefault();
    $(event.shiftKey ? 'redo-button' : 'undo-button').click();
  } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'o') {
    event.preventDefault();
    el.fileInput.click();
  } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
    event.preventDefault();
    exportSelected();
  } else if (event.key === 'f') {
    viewer.frameAll();
  }
});

window.addEventListener('beforeunload', (event) => {
  if (state.models.size === 0) return;
  event.preventDefault();
  event.returnValue = '';
});
