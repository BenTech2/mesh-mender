/**
 * STL, in both flavours.
 *
 * STL has no notion of a shared vertex: every triangle carries its own three
 * corners, which is exactly why STLs arrive looking like they have thousands of
 * holes. Parsing therefore always produces a triangle soup, and welding is the
 * caller's job.
 */
import { Mesh } from '../mesh/core.js';

/**
 * Binary STLs are exactly 84 + 50n bytes, which settles most files outright.
 *
 * For the rest, the test looks for the keywords an ASCII STL must contain.
 * Scanning for bytes above 126 instead — the obvious shortcut, and what this
 * did first — misreads any ASCII STL whose solid name is not plain ASCII: one
 * em dash in a model name is enough to have the whole file parsed as binary
 * and come back as garbage.
 */
export function isBinarySTL(buffer) {
  if (buffer.byteLength < 84) return false;
  const view = new DataView(buffer);
  const count = view.getUint32(80, true);
  if (84 + count * 50 === buffer.byteLength) return true;

  const head = new TextDecoder('utf-8', { fatal: false })
    .decode(new Uint8Array(buffer, 0, Math.min(4096, buffer.byteLength)));
  if (/^\s*solid/i.test(head) && /facet\s+normal|outer\s+loop|vertex\s/i.test(head)) return false;
  return true;
}

export function parseSTL(buffer, name = '') {
  return isBinarySTL(buffer) ? parseBinarySTL(buffer, name) : parseAsciiSTL(buffer, name);
}

export function parseBinarySTL(buffer, name = '') {
  const view = new DataView(buffer);
  const count = view.getUint32(80, true);
  const available = Math.floor((buffer.byteLength - 84) / 50);
  const n = Math.min(count, Math.max(0, available));
  const positions = new Float64Array(n * 9);
  let o = 0;
  for (let i = 0; i < n; i++) {
    const base = 84 + i * 50 + 12; // skip the stored normal, we recompute it
    for (let v = 0; v < 3; v++) {
      const p = base + v * 12;
      positions[o++] = view.getFloat32(p, true);
      positions[o++] = view.getFloat32(p + 4, true);
      positions[o++] = view.getFloat32(p + 8, true);
    }
  }
  const mesh = Mesh.fromSoup(positions);
  mesh.name = name;
  return {
    meshes: [mesh],
    format: 'STL (binary)',
    warnings: count !== n ? [`Header claims ${count} triangles but the file only holds ${n}.`] : [],
  };
}

export function parseAsciiSTL(buffer, name = '') {
  const text = new TextDecoder().decode(buffer);
  const coords = [];
  const re = /vertex\s+(-?[\d.eE+-]+)\s+(-?[\d.eE+-]+)\s+(-?[\d.eE+-]+)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    coords.push(parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3]));
  }
  const warnings = [];
  if (coords.length % 9 !== 0) {
    warnings.push('The file ends mid-triangle; the trailing vertices were dropped.');
    coords.length -= coords.length % 9;
  }
  const solid = /solid\s+([^\r\n]*)/.exec(text);
  const mesh = Mesh.fromSoup(coords);
  mesh.name = name || (solid && solid[1].trim()) || '';
  return { meshes: [mesh], format: 'STL (ASCII)', warnings };
}

export function exportSTLBinary(meshes, { header = 'Made with Mesh Mender' } = {}) {
  const list = Array.isArray(meshes) ? meshes : [meshes];
  let total = 0;
  for (const m of list) total += m.triangleCount;

  const buffer = new ArrayBuffer(84 + total * 50);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  // Truncate the encoded bytes, not the string: slicing to 79 characters first
  // still overflows past byte 80 — and byte 80 is the triangle count — as soon
  // as the header holds anything outside ASCII.
  const head = new TextEncoder().encode(header).subarray(0, 79);
  bytes.set(head, 0);
  view.setUint32(80, total, true);

  let offset = 84;
  const n = [0, 0, 0];
  for (const mesh of list) {
    const p = mesh.positions, ix = mesh.indices;
    for (let f = 0; f < mesh.triangleCount; f++) {
      mesh.faceNormal(f, n);
      view.setFloat32(offset, n[0], true);
      view.setFloat32(offset + 4, n[1], true);
      view.setFloat32(offset + 8, n[2], true);
      offset += 12;
      for (let k = 0; k < 3; k++) {
        const v = ix[f * 3 + k] * 3;
        view.setFloat32(offset, p[v], true);
        view.setFloat32(offset + 4, p[v + 1], true);
        view.setFloat32(offset + 8, p[v + 2], true);
        offset += 12;
      }
      view.setUint16(offset, 0, true);
      offset += 2;
    }
  }
  return buffer;
}

export function exportSTLAscii(meshes, { name = 'model' } = {}) {
  const list = Array.isArray(meshes) ? meshes : [meshes];
  const out = [`solid ${name}`];
  const n = [0, 0, 0];
  const f6 = (x) => (Object.is(x, -0) ? 0 : x).toExponential(6);
  for (const mesh of list) {
    const p = mesh.positions, ix = mesh.indices;
    for (let f = 0; f < mesh.triangleCount; f++) {
      mesh.faceNormal(f, n);
      out.push(`  facet normal ${f6(n[0])} ${f6(n[1])} ${f6(n[2])}`);
      out.push('    outer loop');
      for (let k = 0; k < 3; k++) {
        const v = ix[f * 3 + k] * 3;
        out.push(`      vertex ${f6(p[v])} ${f6(p[v + 1])} ${f6(p[v + 2])}`);
      }
      out.push('    endloop');
      out.push('  endfacet');
    }
  }
  out.push(`endsolid ${name}`, '');
  return out.join('\n');
}
