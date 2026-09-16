/**
 * Winding repair.
 *
 * Two separate problems that get muddled together:
 *  1. Neighbouring triangles disagreeing about which side is out. This is what
 *     makes a slicer render the famous black/inverted patches.
 *  2. A whole shell being consistently inside-out, which looks fine on screen
 *     from outside but makes the solid "everything except the object".
 */
import { Mesh, edgeKey } from './core.js';

/** The three undirected edges of face f, as indices into the edge table. */
function faceEdges(mesh, edges, f, out) {
  const t = f * 3;
  const v0 = mesh.indices[t], v1 = mesh.indices[t + 1], v2 = mesh.indices[t + 2];
  out[0] = edges.map.get(edgeKey(v0, v1));
  out[1] = edges.map.get(edgeKey(v1, v2));
  out[2] = edges.map.get(edgeKey(v2, v0));
  return out;
}

/**
 * Flood-fill each shell making neighbouring faces agree.
 *
 * Crossing a shared edge, two faces are consistent when they traverse it in
 * opposite directions. `flip` tracks whether a face has been reversed, and a
 * reversal swaps its direction on every edge it touches — which is what the
 * XOR below says.
 */
export function makeWindingConsistent(mesh, edges) {
  const nf = mesh.triangleCount;
  const flip = new Uint8Array(nf);
  const seen = new Uint8Array(nf);
  const fe = new Array(3);
  const stack = [];
  let components = 0;
  let conflicts = 0; // edges that stayed wrong: the surface is not orientable there

  for (let seed = 0; seed < nf; seed++) {
    if (seen[seed]) continue;
    components++;
    seen[seed] = 1;
    stack.length = 0;
    stack.push(seed);
    while (stack.length) {
      const f = stack.pop();
      faceEdges(mesh, edges, f, fe);
      for (let k = 0; k < 3; k++) {
        const e = fe[k];
        if (e === undefined) continue;
        const uses = edges.uses[e];
        if (uses.length !== 2) continue;
        const f0 = uses[0] >> 1, d0 = uses[0] & 1;
        const f1 = uses[1] >> 1, d1 = uses[1] & 1;
        const [self, dSelf, nb, dNb] = f0 === f ? [f0, d0, f1, d1] : [f1, d1, f0, d0];
        void self;
        const want = 1 ^ dSelf ^ flip[f] ^ dNb;
        if (!seen[nb]) {
          seen[nb] = 1;
          flip[nb] = want;
          stack.push(nb);
        } else if (flip[nb] !== want) {
          conflicts++;
        }
      }
    }
  }

  let flipped = 0;
  for (let f = 0; f < nf; f++) if (flip[f]) flipped++;
  return { flip, flipped, components, conflicts };
}

/** Rewrite indices according to a per-face flip mask. */
export function applyFlips(mesh, flip) {
  const ix = mesh.indices.slice();
  for (let f = 0; f < flip.length; f++) {
    if (!flip[f]) continue;
    const t = f * 3;
    const tmp = ix[t + 1];
    ix[t + 1] = ix[t + 2];
    ix[t + 2] = tmp;
  }
  const out = new Mesh(mesh.positions, ix);
  out.name = mesh.name; out.unit = mesh.unit;
  return out;
}

/** Signed volume contributed by one subset of faces. */
export function componentVolume(mesh, faces) {
  const p = mesh.positions, ix = mesh.indices;
  let vol = 0;
  for (const f of faces) {
    const t = f * 3;
    const a = ix[t] * 3, b = ix[t + 1] * 3, c = ix[t + 2] * 3;
    vol += p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1])
         - p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c])
         + p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c]);
  }
  return vol / 6;
}

/**
 * Point each shell's normals outwards.
 *
 * Closed shells use the sign of their volume, which is exact. Open shells have
 * no inside, so we fall back to asking whether the normals lean away from the
 * shell's own centre — right for anything roughly convex, and harmless
 * otherwise because an open shell has no watertight meaning anyway.
 */
export function makeNormalsOutward(mesh, comp, componentCount) {
  const nf = mesh.triangleCount;
  const buckets = Array.from({ length: componentCount }, () => []);
  for (let f = 0; f < nf; f++) buckets[comp[f]].push(f);

  const flip = new Uint8Array(nf);
  let flippedShells = 0;
  const p = mesh.positions, ix = mesh.indices;

  for (const faces of buckets) {
    if (faces.length === 0) continue;
    const vol = componentVolume(mesh, faces);
    let inverted;
    if (Math.abs(vol) > 1e-12) {
      inverted = vol < 0;
    } else {
      // Degenerate/flat/open: use the outward-lean heuristic.
      let cx = 0, cy = 0, cz = 0, n = 0;
      for (const f of faces) {
        const t = f * 3;
        for (let k = 0; k < 3; k++) {
          const v = ix[t + k] * 3;
          cx += p[v]; cy += p[v + 1]; cz += p[v + 2]; n++;
        }
      }
      cx /= n; cy /= n; cz /= n;
      let lean = 0;
      const nrm = [0, 0, 0];
      for (const f of faces) {
        mesh.faceNormal(f, nrm);
        const t = f * 3;
        const a = ix[t] * 3, b = ix[t + 1] * 3, c = ix[t + 2] * 3;
        const mx = (p[a] + p[b] + p[c]) / 3 - cx;
        const my = (p[a + 1] + p[b + 1] + p[c + 1]) / 3 - cy;
        const mz = (p[a + 2] + p[b + 2] + p[c + 2]) / 3 - cz;
        lean += nrm[0] * mx + nrm[1] * my + nrm[2] * mz;
      }
      inverted = lean < 0;
    }
    if (inverted) {
      flippedShells++;
      for (const f of faces) flip[f] = 1;
    }
  }
  return { flip, flippedShells };
}
