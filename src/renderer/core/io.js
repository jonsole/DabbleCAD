// Import (STL / OBJ / GLB / 3MF / PLY / SVG / images / .dabble) and export (STL / OBJ / GLB / 3MF / SVG).
import * as THREE from 'three';
import { fusedExportGeometry } from './printcheck.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js';
import { ThreeMFLoader } from 'three/examples/jsm/loaders/3MFLoader.js';
import { SVGLoader } from 'three/examples/jsm/loaders/SVGLoader.js';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { zipSync, strToU8 } from 'three/examples/jsm/libs/fflate.module.js';
import { makeShape, uid, deserializeDoc, cloneNode, PALETTE } from './doc.js';
import { bakedWorldGeometry, getGeometry } from './geometry.js';
import { traceMask, imageToMask, polysBounds } from './trace.js';

export const IMPORT_FILTERS = [
  { name: 'All supported files', extensions: ['stl', 'obj', 'glb', 'gltf', '3mf', 'ply', 'svg', 'png', 'jpg', 'jpeg', 'dabble'] },
  { name: '3D models', extensions: ['stl', 'obj', 'glb', 'gltf', '3mf', 'ply'] },
  { name: 'Vector and images', extensions: ['svg', 'png', 'jpg', 'jpeg'] },
  { name: 'DabbleCAD designs', extensions: ['dabble'] },
];

const text = (buf) => new TextDecoder().decode(buf);
const ext = (name) => (name.split('.').pop() || '').toLowerCase();
const baseName = (name) => name.replace(/\.[^.]+$/, '');
let colorIndex = 0;
const nextColor = () => PALETTE[(colorIndex++ * 5 + 9) % 16];

/** Flatten any Object3D hierarchy into one triangle soup (Float32Array of positions). */
function flatten(root, preMatrix) {
  root.updateMatrixWorld(true);
  const chunks = [];
  let total = 0;
  const v = new THREE.Vector3();
  root.traverse((o) => {
    if (!o.isMesh || !o.geometry || !o.geometry.attributes.position) return;
    const g = o.geometry.index ? o.geometry.toNonIndexed() : o.geometry;
    const pos = g.attributes.position;
    const m = preMatrix ? preMatrix.clone().multiply(o.matrixWorld) : o.matrixWorld;
    const arr = new Float32Array(pos.count * 3);
    const flip = m.determinant() < 0;
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(m);
      let k = i;
      if (flip) { const r = i % 3; k = r === 1 ? i + 1 : r === 2 ? i - 1 : i; }
      arr[k * 3] = v.x; arr[k * 3 + 1] = v.y; arr[k * 3 + 2] = v.z;
    }
    chunks.push(arr);
    total += arr.length;
  });
  const out = new Float32Array(total);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

function meshNode(positions, name, fitTo) {
  if (positions.length < 9) throw new Error('No triangles found in ' + name);
  const node = makeShape('mesh', { mesh: { id: uid('m'), positions } }, nextColor(), baseName(name));
  // very large or very small models are rescaled so they are usable straight away
  const box = new THREE.Box3().setFromArray(positions);
  const size = box.getSize(new THREE.Vector3());
  const max = Math.max(size.x, size.y, size.z);
  let scale = 1;
  if (max > fitTo * 1.5) scale = (fitTo * 0.8) / max;
  else if (max < 0.5 && max > 0) scale = 20 / max;
  node.matrix[0] = node.matrix[5] = node.matrix[10] = scale;
  return { node, scale, triangles: positions.length / 9 };
}

const Y_UP_TO_Z_UP = new THREE.Matrix4().makeRotationX(Math.PI / 2);

function svgToPolys(svgText) {
  const data = new SVGLoader().parse(svgText);
  const polys = [];
  for (const path of data.paths) {
    const style = path.userData && path.userData.style;
    if (style && style.fill === 'none' && (!style.stroke || style.stroke === 'none')) continue;
    let shapes = [];
    if (!style || (style.fill && style.fill !== 'none')) shapes = path.toShapes();
    if (!shapes.length && style && style.stroke && style.stroke !== 'none') {
      // stroke-only art: turn the stroke outline into triangles is overkill, use closed sub paths instead
      shapes = path.subPaths.filter((sp) => sp.getPoints().length > 2).map((sp) => new THREE.Shape(sp.getPoints(8)));
    }
    for (const shape of shapes) {
      const pts = shape.extractPoints(10);
      if (pts.shape.length < 3) continue;
      polys.push({ outer: pts.shape.map((p) => [p.x, -p.y]), holes: pts.holes.filter((hh) => hh.length > 2).map((hh) => hh.map((p) => [p.x, -p.y])) });
    }
  }
  return polys;
}

function fitPolys(polys, target) {
  const b = polysBounds(polys);
  const max = Math.max(b.width, b.height) || 1;
  const s = max > target ? target / max : max < 5 ? 20 / max : 1;
  const map = (p) => [(p[0] - b.minX - b.width / 2) * s, (p[1] - b.minY - b.height / 2) * s];
  return polys.map((poly) => ({ outer: poly.outer.map(map), holes: poly.holes.map((hh) => hh.map(map)) }));
}

export function extrusionNode(polys, name, depth = 10, extra = {}) {
  return makeShape('extrusion', { pid: uid('p'), polys, depth, ...extra }, nextColor(), name);
}

function loadImage(buffer, mime) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(new Blob([buffer], { type: mime }));
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read the image')); };
    img.src = url;
  });
}

async function imageToNode(file) {
  const e = ext(file.name);
  const img = await loadImage(file.data, e === 'png' ? 'image/png' : 'image/jpeg');
  const maxSide = 420;
  const k = Math.min(1, maxSide / Math.max(img.width, img.height));
  const w = Math.max(2, Math.round(img.width * k)), hgt = Math.max(2, Math.round(img.height * k));
  const c = document.createElement('canvas');
  c.width = w; c.height = hgt;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, w, hgt);
  const mask = imageToMask(ctx.getImageData(0, 0, w, hgt));
  const polys = traceMask(mask, w, hgt, { scale: 1, smooth: 1 });
  if (!polys.length) throw new Error('No dark or opaque areas were found in ' + file.name);
  return extrusionNode(fitPolys(polys, 100), baseName(file.name), 5);
}

/**
 * Parse files into nodes. Returns { nodes, messages }.
 * Each file: { name, data: ArrayBuffer }.
 */
export async function importFiles(files, { fitTo = 200 } = {}) {
  const nodes = [];
  const messages = [];
  for (const file of files) {
    const e = ext(file.name);
    try {
      if (e === 'dabble') {
        const doc = deserializeDoc(text(file.data));
        nodes.push(...doc.nodes.map((n) => cloneNode(n, true)));
        continue;
      }
      if (e === 'svg') {
        const polys = svgToPolys(text(file.data));
        if (!polys.length) throw new Error('No filled shapes found in ' + file.name);
        nodes.push(extrusionNode(fitPolys(polys, Math.min(fitTo * 0.8, 150)), baseName(file.name), 5));
        continue;
      }
      if (e === 'png' || e === 'jpg' || e === 'jpeg') {
        nodes.push(await imageToNode(file));
        continue;
      }
      let positions;
      if (e === 'stl') {
        positions = flatten(new THREE.Mesh(new STLLoader().parse(file.data)));
      } else if (e === 'obj') {
        positions = flatten(new OBJLoader().parse(text(file.data)), Y_UP_TO_Z_UP);
      } else if (e === 'ply') {
        const pg = new PLYLoader().parse(file.data);
        // PLY files without faces are point clouds: their vertices are not a triangle list
        if (!pg.index) throw new Error('No triangles found (point cloud?)');
        positions = flatten(new THREE.Mesh(pg));
      } else if (e === '3mf') {
        positions = flatten(new ThreeMFLoader().parse(file.data));
      } else if (e === 'glb' || e === 'gltf') {
        const gltf = await new GLTFLoader().parseAsync(file.data, '');
        positions = flatten(gltf.scene, Y_UP_TO_Z_UP.clone().multiply(new THREE.Matrix4().makeScale(1000, 1000, 1000)));
      } else {
        throw new Error('Unsupported file type: .' + e);
      }
      const res = meshNode(positions, file.name, fitTo);
      nodes.push(res.node);
      if (res.scale !== 1) messages.push(`${file.name} was scaled to ${Math.round(res.scale * 1000) / 10}% to fit the workplane`);
      if (res.triangles > 400000) messages.push(`${file.name} is a heavy mesh (${Math.round(res.triangles / 1000)}k triangles); grouping may be slow`);
    } catch (err) {
      console.warn(err);
      messages.push(`Could not import ${file.name}: ${err.message || err}`);
    }
  }
  return { nodes, messages };
}

// ------------------------------------------------------------------ export
export const EXPORT_FORMATS = [
  { id: 'stl', name: 'STL', hint: '3D printing (single mesh, millimetres)' },
  { id: '3mf', name: '3MF', hint: '3D printing with separate coloured parts' },
  { id: 'obj', name: 'OBJ', hint: 'Mesh with per-part colours' },
  { id: 'glb', name: 'GLB', hint: 'glTF binary for web / AR, with colours' },
  { id: 'svg', name: 'SVG', hint: 'Outline where the design meets the workplane (laser cutting)' },
];

function exportNodes(editor, selectedOnly) {
  const pool = selectedOnly ? editor.selectedNodes() : editor.doc.nodes;
  return pool.filter((n) => !n.hidden && !n.hole && getGeometry(n).attributes.position.count > 0);
}

function partName(node, i) {
  return (node.name || (node.type === 'group' ? 'Group' : node.kind) || 'part').replace(/[^\w -]/g, '') + '_' + (i + 1);
}

function writeSTL(geos) {
  let tris = 0;
  for (const g of geos) tris += g.attributes.position.count / 3;
  const buf = new ArrayBuffer(84 + tris * 50);
  const dv = new DataView(buf);
  const header = 'DabbleCAD Plus binary STL';
  for (let i = 0; i < header.length; i++) dv.setUint8(i, header.charCodeAt(i));
  let o = 84;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3();
  for (const g of geos) {
    const pos = g.attributes.position;
    for (let i = 0; i < pos.count; i += 3) {
      a.fromBufferAttribute(pos, i); b.fromBufferAttribute(pos, i + 1); c.fromBufferAttribute(pos, i + 2);
      // Welding or baking transforms can collapse a facet to an edge or point.
      if (a.equals(b) || b.equals(c) || c.equals(a)) continue;
      n.subVectors(b, a).cross(c.clone().sub(a)).normalize();
      for (const v of [n, a, b, c]) { dv.setFloat32(o, v.x, true); dv.setFloat32(o + 4, v.y, true); dv.setFloat32(o + 8, v.z, true); o += 12; }
      o += 2;
    }
  }
  dv.setUint32(80, (o - 84) / 50, true);
  return new Uint8Array(o === buf.byteLength ? buf : buf.slice(0, o));
}

function writeOBJ(nodes, geos) {
  const out = ['# DabbleCAD Plus OBJ export (millimetres, Z up)'];
  let offset = 1;
  const f = (v) => +v.toFixed(5);
  // colour attributes are linear; OBJ vertex colours are read as sRGB
  const lin = new THREE.Color(), rgb = { r: 0, g: 0, b: 0 };
  const srgb = (col, i) => { lin.setRGB(col.getX(i), col.getY(i), col.getZ(i)).getRGB(rgb, THREE.SRGBColorSpace); return ` ${f(rgb.r)} ${f(rgb.g)} ${f(rgb.b)}`; };
  geos.forEach((g, gi) => {
    const pos = g.attributes.position, nor = g.attributes.normal, col = g.attributes.color;
    out.push('o ' + partName(nodes[gi], gi));
    for (let i = 0; i < pos.count; i++) {
      out.push(`v ${f(pos.getX(i))} ${f(pos.getY(i))} ${f(pos.getZ(i))}` + (col ? srgb(col, i) : ''));
    }
    for (let i = 0; i < pos.count; i++) out.push(`vn ${f(nor.getX(i))} ${f(nor.getY(i))} ${f(nor.getZ(i))}`);
    for (let i = 0; i < pos.count; i += 3) {
      const a = offset + i, b = a + 1, c = a + 2;
      out.push(`f ${a}//${a} ${b}//${b} ${c}//${c}`);
    }
    offset += pos.count;
  });
  return out.join('\n') + '\n';
}

function write3MF(nodes, geos) {
  const hex = (node) => (node.color || '#cccccc').toUpperCase() + 'FF';
  const parts = [];
  const items = [];
  const mats = nodes.map((n, i) => `<base name="${partName(n, i)}" displaycolor="${hex(n)}"/>`).join('');
  geos.forEach((g, i) => {
    const plain = new THREE.BufferGeometry();
    plain.setAttribute('position', g.attributes.position.clone());
    const m = mergeVertices(plain, 1e-4);
    const pos = m.attributes.position, idx = m.index;
    const verts = [];
    for (let k = 0; k < pos.count; k++) verts.push(`<vertex x="${+pos.getX(k).toFixed(5)}" y="${+pos.getY(k).toFixed(5)}" z="${+pos.getZ(k).toFixed(5)}"/>`);
    const tris = [];
    for (let k = 0; k < idx.count; k += 3) {
      const a = idx.getX(k), b = idx.getX(k + 1), c = idx.getX(k + 2);
      if (a !== b && b !== c && a !== c) tris.push(`<triangle v1="${a}" v2="${b}" v3="${c}"/>`);
    }
    const id = i + 2;
    parts.push(`<object id="${id}" name="${partName(nodes[i], i)}" type="model" pid="1" pindex="${i}"><mesh><vertices>${verts.join('')}</vertices><triangles>${tris.join('')}</triangles></mesh></object>`);
    items.push(`<item objectid="${id}"/>`);
  });
  const model = `<?xml version="1.0" encoding="UTF-8"?>\n<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><metadata name="Application">DabbleCAD</metadata><resources><basematerials id="1">${mats}</basematerials>${parts.join('')}</resources><build>${items.join('')}</build></model>`;
  const types = '<?xml version="1.0" encoding="UTF-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>';
  const rels = '<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>';
  return zipSync({ '[Content_Types].xml': strToU8(types), '_rels/.rels': strToU8(rels), '3D/3dmodel.model': strToU8(model) });
}

function writeGLB(nodes, geos) {
  const scene = new THREE.Scene();
  const root = new THREE.Group();
  root.rotation.x = -Math.PI / 2; // Z-up -> Y-up
  root.scale.setScalar(0.001); // millimetres -> metres
  scene.add(root);
  geos.forEach((g, i) => {
    const multi = nodes[i].type === 'group' && nodes[i].multicolor;
    const geo = g.clone();
    if (!multi) geo.deleteAttribute('color');
    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: multi ? '#ffffff' : nodes[i].color, vertexColors: multi, roughness: 0.6, metalness: 0 }));
    mesh.name = partName(nodes[i], i);
    root.add(mesh);
  });
  return new Promise((resolve, reject) => {
    new GLTFExporter().parse(scene, (result) => resolve(new Uint8Array(result)), reject, { binary: true });
  });
}

/** Cross-section of the design with the workplane, as SVG paths in millimetres. */
function writeSVG(geos, height = 0.01) {
  const segs = [];
  const p = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  for (const g of geos) {
    const pos = g.attributes.position;
    for (let i = 0; i < pos.count; i += 3) {
      for (let k = 0; k < 3; k++) p[k].fromBufferAttribute(pos, i + k);
      const pts = [];
      for (let k = 0; k < 3; k++) {
        const a = p[k], b = p[(k + 1) % 3];
        if ((a.z - height) * (b.z - height) < 0) {
          const t = (height - a.z) / (b.z - a.z);
          pts.push([a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t]);
        }
      }
      if (pts.length === 2) segs.push(pts);
    }
  }
  if (!segs.length) return null;
  const key = (q) => Math.round(q[0] * 500) + ',' + Math.round(q[1] * 500);
  const ends = new Map();
  segs.forEach((s, i) => { for (const e of [0, 1]) { const k = key(s[e]); (ends.get(k) || ends.set(k, []).get(k)).push([i, e]); } });
  const used = new Uint8Array(segs.length);
  const paths = [];
  for (let i = 0; i < segs.length; i++) {
    if (used[i]) continue;
    used[i] = 1;
    const line = [segs[i][0], segs[i][1]];
    for (const dir of [1, 0]) {
      for (;;) {
        const tip = dir ? line[line.length - 1] : line[0];
        const next = (ends.get(key(tip)) || []).find(([si]) => !used[si]);
        if (!next) break;
        used[next[0]] = 1;
        const other = segs[next[0]][1 - next[1]];
        if (dir) line.push(other); else line.unshift(other);
      }
    }
    paths.push(line);
  }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const l of paths) for (const [x, y] of l) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
  const w = maxX - minX, hgt = maxY - minY;
  const f = (v) => +v.toFixed(3);
  const d = paths.map((l) => {
    const closed = key(l[0]) === key(l[l.length - 1]);
    const pts = closed ? l.slice(0, -1) : l;
    return 'M' + pts.map(([x, y]) => `${f(x - minX)} ${f(maxY - y)}`).join('L') + (closed ? 'Z' : '');
  }).join(' ');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${f(w)}mm" height="${f(hgt)}mm" viewBox="0 0 ${f(w)} ${f(hgt)}">\n  <path d="${d}" fill="none" stroke="#000000" stroke-width="0.1"/>\n</svg>\n`;
}

/** Build export data. Returns { data, extension, filterName } or throws. */
export async function exportModel(editor, format, { selectedOnly = false, fuse = true } = {}) {
  const nodes = exportNodes(editor, selectedOnly);
  if (!nodes.length) throw new Error(selectedOnly ? 'Select at least one solid shape to export' : 'There is nothing to export yet');
  const geos = nodes.map((n) => bakedWorldGeometry(n, true));
  switch (format) {
    case 'stl': {
      // one watertight shell prints more reliably than overlapping ones; fall back when a part is not a closed solid
      const fused = fuse && nodes.length > 1 ? fusedExportGeometry(nodes) : null;
      return { data: writeSTL(fused ? [fused] : geos), extension: 'stl', filterName: 'STL mesh', fused: !!fused };
    }
    case 'obj': return { data: writeOBJ(nodes, geos), extension: 'obj', filterName: 'Wavefront OBJ' };
    case '3mf': return { data: write3MF(nodes, geos), extension: '3mf', filterName: '3MF model' };
    case 'glb': return { data: await writeGLB(nodes, geos), extension: 'glb', filterName: 'glTF binary' };
    case 'svg': {
      const svg = writeSVG(geos);
      if (!svg) throw new Error('Nothing touches the workplane, so there is no outline to export');
      return { data: svg, extension: 'svg', filterName: 'SVG drawing' };
    }
    default: throw new Error('Unknown format ' + format);
  }
}

export function dataUrlToBytes(url) {
  const bin = atob(url.slice(url.indexOf(',') + 1));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
