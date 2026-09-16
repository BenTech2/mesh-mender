/**
 * 3MF — the format 3D Builder saved in, and the one worth moving to: it stores
 * a proper indexed mesh with units, so a model survives a round trip without
 * being dissolved back into a triangle soup the way STL does.
 *
 * The XML is scanned with a small tag reader rather than DOMParser, because
 * DOMParser does not exist inside a Web Worker and all the heavy lifting here
 * runs in one.
 */
import { Mesh } from '../mesh/core.js';
import { unzipSync, zipSync, strFromU8, strToU8 } from '../../vendor/fflate.module.js';

const TAG = /<(\/?)([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*"[^"]*")*)\s*(\/?)\s*>/g;
const ATTR = /([\w:.-]+)\s*=\s*"([^"]*)"/g;

function attrs(text) {
  const out = {};
  if (!text) return out;
  ATTR.lastIndex = 0;
  let m;
  while ((m = ATTR.exec(text)) !== null) out[m[1]] = m[2];
  return out;
}

/** 3MF transforms are 12 numbers, a 4x3 row-major matrix with translation last. */
function parseTransform(text) {
  if (!text) return null;
  const n = text.trim().split(/\s+/).map(Number);
  if (n.length !== 12 || n.some(Number.isNaN)) return null;
  return n;
}

function applyTransform(positions, t) {
  if (!t) return positions;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i], y = positions[i + 1], z = positions[i + 2];
    positions[i]     = x * t[0] + y * t[3] + z * t[6] + t[9];
    positions[i + 1] = x * t[1] + y * t[4] + z * t[7] + t[10];
    positions[i + 2] = x * t[2] + y * t[5] + z * t[8] + t[11];
  }
  return positions;
}

function multiply(a, b) {
  // Compose two 4x3 row-major transforms: result = a then b.
  if (!a) return b;
  if (!b) return a;
  const out = new Array(12);
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 3; c++) {
      let sum = 0;
      for (let k = 0; k < 3; k++) sum += a[r * 3 + k] * b[k * 3 + c];
      if (r === 3) sum += b[9 + c];
      out[r * 3 + c] = sum;
    }
  }
  return out;
}

function determinant(t) {
  if (!t) return 1;
  return t[0] * (t[4] * t[8] - t[5] * t[7])
       - t[1] * (t[3] * t[8] - t[5] * t[6])
       + t[2] * (t[3] * t[7] - t[4] * t[6]);
}

export function parseModelXML(xml) {
  const objects = new Map();
  const items = [];
  let unit = 'millimeter';

  let object = null;      // the object currently being read
  let inVertices = false;
  let inTriangles = false;

  TAG.lastIndex = 0;
  let m;
  while ((m = TAG.exec(xml)) !== null) {
    const closing = m[1] === '/';
    const name = m[2].replace(/^.*:/, '');
    const selfClosing = m[4] === '/';

    if (name === 'model' && !closing) {
      const a = attrs(m[3]);
      if (a.unit) unit = a.unit;
    } else if (name === 'object') {
      if (closing) { object = null; continue; }
      const a = attrs(m[3]);
      object = {
        id: a.id, type: a.type || 'model', name: a.name || '',
        positions: [], indices: [], components: [],
      };
      objects.set(a.id, object);
      if (selfClosing) object = null;
    } else if (name === 'vertices') {
      inVertices = !closing && !selfClosing;
    } else if (name === 'triangles') {
      inTriangles = !closing && !selfClosing;
    } else if (name === 'vertex' && !closing && object && inVertices) {
      const a = attrs(m[3]);
      object.positions.push(+a.x, +a.y, +a.z);
    } else if (name === 'triangle' && !closing && object && inTriangles) {
      const a = attrs(m[3]);
      object.indices.push(+a.v1, +a.v2, +a.v3);
    } else if (name === 'component' && !closing && object) {
      const a = attrs(m[3]);
      object.components.push({ objectid: a.objectid, transform: parseTransform(a.transform) });
    } else if (name === 'item' && !closing) {
      const a = attrs(m[3]);
      items.push({ objectid: a.objectid, transform: parseTransform(a.transform) });
    }
  }

  return { objects, items, unit };
}

/** Flatten one object (and anything it references) into a single mesh. */
function bakeObject(objects, id, transform, seen, out) {
  if (seen.has(id)) return; // a malformed file could reference itself
  const object = objects.get(id);
  if (!object) return;
  seen.add(id);

  if (object.indices.length) {
    const base = out.positions.length / 3;
    const positions = applyTransform(Float64Array.from(object.positions), transform);
    for (let i = 0; i < positions.length; i++) out.positions.push(positions[i]);
    const flip = determinant(transform) < 0;
    for (let t = 0; t < object.indices.length; t += 3) {
      if (flip) out.indices.push(object.indices[t] + base, object.indices[t + 2] + base, object.indices[t + 1] + base);
      else out.indices.push(object.indices[t] + base, object.indices[t + 1] + base, object.indices[t + 2] + base);
    }
  }
  for (const c of object.components) {
    bakeObject(objects, c.objectid, multiply(c.transform, transform), seen, out);
  }
  seen.delete(id);
}

export function parse3MF(buffer, name = '') {
  const files = unzipSync(new Uint8Array(buffer));
  const modelPath = Object.keys(files).find((p) => /3dmodel\.model$/i.test(p))
    || Object.keys(files).find((p) => /\.model$/i.test(p));
  if (!modelPath) throw new Error('No 3D model part found inside the 3MF package.');

  const { objects, items, unit } = parseModelXML(strFromU8(files[modelPath]));
  const warnings = [];
  const meshes = [];

  const build = items.length
    ? items
    : Array.from(objects.values()).filter((o) => o.indices.length || o.components.length)
        .map((o) => ({ objectid: o.id, transform: null }));
  if (!items.length && build.length) {
    warnings.push('The file has no build section; every object in it was loaded.');
  }

  for (const item of build) {
    const out = { positions: [], indices: [] };
    bakeObject(objects, item.objectid, item.transform, new Set(), out);
    if (!out.indices.length) continue;
    const mesh = new Mesh(new Float64Array(out.positions), new Uint32Array(out.indices));
    const object = objects.get(item.objectid);
    mesh.name = (object && object.name) || (name ? `${name}` : `object ${item.objectid}`);
    mesh.unit = unit;
    meshes.push(mesh);
  }

  if (!meshes.length) throw new Error('The 3MF package contains no triangles.');
  return { meshes, format: '3MF', warnings, unit };
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
</Types>`;

const RELS = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>`;

function escapeXML(s) {
  return String(s).replace(/[<>&"']/g, (c) =>
    ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
}

export function buildModelXML(meshes, unit = 'millimeter') {
  const list = Array.isArray(meshes) ? meshes : [meshes];
  const parts = [];
  parts.push('<?xml version="1.0" encoding="UTF-8"?>');
  parts.push(`<model unit="${escapeXML(unit)}" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">`);
  parts.push('  <metadata name="Application">Mesh Mender</metadata>');
  parts.push('  <resources>');
  list.forEach((mesh, i) => {
    const id = i + 1;
    parts.push(`    <object id="${id}" type="model"${mesh.name ? ` name="${escapeXML(mesh.name)}"` : ''}>`);
    parts.push('      <mesh>');
    parts.push('        <vertices>');
    const p = mesh.positions;
    for (let v = 0; v < p.length; v += 3) {
      parts.push(`          <vertex x="${num(p[v])}" y="${num(p[v + 1])}" z="${num(p[v + 2])}"/>`);
    }
    parts.push('        </vertices>');
    parts.push('        <triangles>');
    const ix = mesh.indices;
    for (let t = 0; t < ix.length; t += 3) {
      parts.push(`          <triangle v1="${ix[t]}" v2="${ix[t + 1]}" v3="${ix[t + 2]}"/>`);
    }
    parts.push('        </triangles>');
    parts.push('      </mesh>');
    parts.push('    </object>');
  });
  parts.push('  </resources>');
  parts.push('  <build>');
  list.forEach((_, i) => parts.push(`    <item objectid="${i + 1}"/>`));
  parts.push('  </build>');
  parts.push('</model>');
  return parts.join('\n');
}

export function export3MF(meshes, { unit = 'millimeter' } = {}) {
  const model = buildModelXML(meshes, unit);
  const zipped = zipSync({
    '[Content_Types].xml': strToU8(CONTENT_TYPES),
    '_rels/.rels': strToU8(RELS),
    '3D/3dmodel.model': strToU8(model),
  }, { level: 6 });
  return zipped.buffer.slice(zipped.byteOffset, zipped.byteOffset + zipped.byteLength);
}

function num(x) {
  return Number(x.toPrecision(9)).toString();
}
