/**
 * Wavefront OBJ. Only geometry is read — materials, texture coordinates and
 * smoothing groups are irrelevant to printing and are skipped.
 */
import { Mesh } from '../mesh/core.js';

export function parseOBJ(buffer, name = '') {
  const text = typeof buffer === 'string' ? buffer : new TextDecoder().decode(buffer);
  const positions = [];
  const indices = [];
  const warnings = [];
  let ngons = 0;

  const lines = text.split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (line.length === 0 || line.charCodeAt(0) === 35 /* # */) continue;
    if (line.startsWith('v ')) {
      const parts = line.split(/\s+/);
      positions.push(+parts[1], +parts[2], +parts[3]);
    } else if (line.startsWith('f ')) {
      const parts = line.split(/\s+/);
      const face = [];
      for (let i = 1; i < parts.length; i++) {
        const token = parts[i];
        if (!token) continue;
        const slash = token.indexOf('/');
        const vs = slash === -1 ? token : token.slice(0, slash);
        let v = parseInt(vs, 10);
        if (Number.isNaN(v)) continue;
        // OBJ indices are 1-based; negative counts back from the end.
        v = v < 0 ? positions.length / 3 + v : v - 1;
        face.push(v);
      }
      if (face.length < 3) continue;
      if (face.length > 3) ngons++;
      for (let i = 1; i + 1 < face.length; i++) {
        indices.push(face[0], face[i], face[i + 1]);
      }
    }
  }
  if (ngons) warnings.push(`${ngons} faces with more than 3 corners were split into triangles.`);

  const mesh = new Mesh(new Float64Array(positions), new Uint32Array(indices));
  mesh.name = name;
  return { meshes: [mesh], format: 'OBJ', warnings };
}

export function exportOBJ(meshes, { name = 'model' } = {}) {
  const list = Array.isArray(meshes) ? meshes : [meshes];
  const out = [`# ${name} — repaired with Mesh Mender`];
  let base = 1;
  for (const mesh of list) {
    if (mesh.name) out.push(`o ${mesh.name.replace(/\s+/g, '_')}`);
    const p = mesh.positions;
    for (let i = 0; i < p.length; i += 3) {
      out.push(`v ${trim(p[i])} ${trim(p[i + 1])} ${trim(p[i + 2])}`);
    }
    const ix = mesh.indices;
    for (let t = 0; t < ix.length; t += 3) {
      out.push(`f ${ix[t] + base} ${ix[t + 1] + base} ${ix[t + 2] + base}`);
    }
    base += mesh.vertexCount;
  }
  out.push('');
  return out.join('\n');
}

function trim(x) {
  return Number(x.toPrecision(9)).toString();
}
