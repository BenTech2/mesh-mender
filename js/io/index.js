/**
 * Format dispatch. Sniffs by extension first, then by content, because plenty
 * of files arrive with the wrong extension (or none at all, when dragged out of
 * an archive).
 */
import { parseSTL, exportSTLBinary, exportSTLAscii } from './stl.js';
import { parseOBJ, exportOBJ } from './obj.js';
import { parsePLY } from './ply.js';
import { parse3MF, export3MF } from './threemf.js';

export const SUPPORTED_EXTENSIONS = ['.stl', '.obj', '.3mf', '.ply'];

function extensionOf(filename) {
  const i = filename.lastIndexOf('.');
  return i === -1 ? '' : filename.slice(i).toLowerCase();
}

function looksLikeZip(buffer) {
  const b = new Uint8Array(buffer, 0, Math.min(4, buffer.byteLength));
  return b[0] === 0x50 && b[1] === 0x4b;
}

function baseName(filename) {
  return filename.replace(/\.[^.]+$/, '').replace(/^.*[\\/]/, '');
}

export function loadFile(filename, buffer) {
  const ext = extensionOf(filename);
  const name = baseName(filename);

  if (ext === '.3mf' || (ext === '' && looksLikeZip(buffer))) return parse3MF(buffer, name);
  if (ext === '.obj') return parseOBJ(buffer, name);
  if (ext === '.ply') return parsePLY(buffer, name);
  if (ext === '.stl') return parseSTL(buffer, name);

  // Unknown extension: work it out from the bytes.
  if (looksLikeZip(buffer)) return parse3MF(buffer, name);
  const head = new TextDecoder().decode(new Uint8Array(buffer, 0, Math.min(256, buffer.byteLength)));
  if (/^ply\s/.test(head)) return parsePLY(buffer, name);
  if (/^\s*(#|v\s|o\s|g\s|mtllib)/.test(head)) return parseOBJ(buffer, name);
  return parseSTL(buffer, name);
}

export const EXPORT_FORMATS = {
  '3mf': { label: '3MF', extension: '.3mf', binary: true, mime: 'model/3mf' },
  'stl': { label: 'STL (binary)', extension: '.stl', binary: true, mime: 'model/stl' },
  'stl-ascii': { label: 'STL (ASCII)', extension: '.stl', binary: false, mime: 'model/stl' },
  'obj': { label: 'OBJ', extension: '.obj', binary: false, mime: 'text/plain' },
};

export function exportMeshes(meshes, format, opts = {}) {
  const list = Array.isArray(meshes) ? meshes : [meshes];
  switch (format) {
    case '3mf': return export3MF(list, { unit: opts.unit || list[0]?.unit || 'millimeter' });
    case 'stl': return exportSTLBinary(list, opts);
    case 'stl-ascii': return exportSTLAscii(list, opts);
    case 'obj': return exportOBJ(list, opts);
    default: throw new Error(`Unknown export format: ${format}`);
  }
}
