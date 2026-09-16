/**
 * PLY reader — ASCII and little-endian binary. Scanners produce these
 * constantly, and they are usually the messiest meshes of the lot.
 */
import { Mesh } from '../mesh/core.js';

const TYPE_SIZE = {
  char: 1, uchar: 1, int8: 1, uint8: 1,
  short: 2, ushort: 2, int16: 2, uint16: 2,
  int: 4, uint: 4, int32: 4, uint32: 4, float: 4, float32: 4,
  double: 8, float64: 8,
};

function readScalar(view, offset, type, little) {
  switch (type) {
    case 'char': case 'int8': return view.getInt8(offset);
    case 'uchar': case 'uint8': return view.getUint8(offset);
    case 'short': case 'int16': return view.getInt16(offset, little);
    case 'ushort': case 'uint16': return view.getUint16(offset, little);
    case 'int': case 'int32': return view.getInt32(offset, little);
    case 'uint': case 'uint32': return view.getUint32(offset, little);
    case 'float': case 'float32': return view.getFloat32(offset, little);
    case 'double': case 'float64': return view.getFloat64(offset, little);
    default: return 0;
  }
}

export function parsePLY(buffer, name = '') {
  const bytes = new Uint8Array(buffer);
  const headerText = new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.length, 65536)));
  const endIndex = headerText.indexOf('end_header');
  if (endIndex === -1) throw new Error('Not a PLY file: no end_header line.');
  const headerEnd = endIndex + 'end_header'.length + (headerText[endIndex + 10] === '\r' ? 2 : 1);
  const header = headerText.slice(0, endIndex).split(/\r?\n/);

  let format = 'ascii';
  const elements = [];
  let current = null;
  for (const line of header) {
    const parts = line.trim().split(/\s+/);
    if (parts[0] === 'format') format = parts[1];
    else if (parts[0] === 'element') {
      current = { name: parts[1], count: parseInt(parts[2], 10), properties: [] };
      elements.push(current);
    } else if (parts[0] === 'property' && current) {
      if (parts[1] === 'list') {
        current.properties.push({ list: true, countType: parts[2], itemType: parts[3], name: parts[4] });
      } else {
        current.properties.push({ list: false, type: parts[1], name: parts[2] });
      }
    }
  }

  const positions = [];
  const indices = [];
  const warnings = [];
  let ngons = 0;

  const pushFace = (face) => {
    if (face.length < 3) return;
    if (face.length > 3) ngons++;
    for (let i = 1; i + 1 < face.length; i++) indices.push(face[0], face[i], face[i + 1]);
  };

  if (format === 'ascii') {
    const body = new TextDecoder().decode(bytes.subarray(headerEnd));
    const tokens = body.split(/\s+/).filter((t) => t.length);
    let cursor = 0;
    for (const el of elements) {
      for (let i = 0; i < el.count; i++) {
        if (el.name === 'vertex') {
          let x = 0, y = 0, z = 0;
          for (const prop of el.properties) {
            const value = parseFloat(tokens[cursor++]);
            if (prop.name === 'x') x = value;
            else if (prop.name === 'y') y = value;
            else if (prop.name === 'z') z = value;
          }
          positions.push(x, y, z);
        } else if (el.name === 'face') {
          for (const prop of el.properties) {
            if (prop.list) {
              const n = parseInt(tokens[cursor++], 10);
              const face = [];
              for (let k = 0; k < n; k++) face.push(parseInt(tokens[cursor++], 10));
              if (prop.name === 'vertex_indices' || prop.name === 'vertex_index') pushFace(face);
            } else cursor++;
          }
        } else {
          for (const prop of el.properties) {
            if (prop.list) {
              const n = parseInt(tokens[cursor++], 10);
              cursor += n;
            } else cursor++;
          }
        }
      }
    }
  } else {
    const little = format === 'binary_little_endian';
    const view = new DataView(buffer);
    let offset = headerEnd;
    for (const el of elements) {
      for (let i = 0; i < el.count; i++) {
        if (el.name === 'vertex') {
          let x = 0, y = 0, z = 0;
          for (const prop of el.properties) {
            const size = TYPE_SIZE[prop.type] || 4;
            const value = readScalar(view, offset, prop.type, little);
            offset += size;
            if (prop.name === 'x') x = value;
            else if (prop.name === 'y') y = value;
            else if (prop.name === 'z') z = value;
          }
          positions.push(x, y, z);
        } else if (el.name === 'face') {
          for (const prop of el.properties) {
            if (prop.list) {
              const n = readScalar(view, offset, prop.countType, little);
              offset += TYPE_SIZE[prop.countType] || 1;
              const itemSize = TYPE_SIZE[prop.itemType] || 4;
              const face = [];
              for (let k = 0; k < n; k++) {
                face.push(readScalar(view, offset, prop.itemType, little));
                offset += itemSize;
              }
              if (prop.name === 'vertex_indices' || prop.name === 'vertex_index') pushFace(face);
            } else {
              offset += TYPE_SIZE[prop.type] || 4;
            }
          }
        } else {
          for (const prop of el.properties) {
            if (prop.list) {
              const n = readScalar(view, offset, prop.countType, little);
              offset += (TYPE_SIZE[prop.countType] || 1) + n * (TYPE_SIZE[prop.itemType] || 4);
            } else offset += TYPE_SIZE[prop.type] || 4;
          }
        }
      }
    }
  }

  if (ngons) warnings.push(`${ngons} faces with more than 3 corners were split into triangles.`);
  const mesh = new Mesh(new Float64Array(positions), new Uint32Array(indices));
  mesh.name = name;
  return { meshes: [mesh], format: `PLY (${format})`, warnings };
}
