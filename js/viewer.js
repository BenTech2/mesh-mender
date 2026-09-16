/**
 * The 3D view: build plate, model, and the overlays that make defects visible.
 *
 * Z is up, as it is in every printing toolchain and in the STL/3MF files
 * themselves. three.js defaults to Y-up, so the camera and grid are turned once
 * here rather than rotating every model on load.
 */
import * as THREE from '../vendor/three.module.js';
import { OrbitControls } from '../vendor/controls/OrbitControls.js';

/** Green: the four defect colours are spoken for, and selection is not a defect. */
export const SELECTION_COLOUR = 0x3ddc97;

export const HIGHLIGHT_COLOURS = {
  boundary: 0xff3b5c,
  nonManifold: 0xffb02e,
  flipped: 0x4da3ff,
  intersecting: 0xd965ff,
};

export class Viewer {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(0x0f1319, 1);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(40, 1, 0.1, 500000);
    this.camera.up.set(0, 0, 1);
    this.camera.position.set(160, -220, 150);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.09;
    this.controls.screenSpacePanning = false;

    this.models = new Map();
    this.selectedId = null;
    this.tween = null;
    this.plateSize = 220;
    this.showWireframe = false;
    this.showBackfaces = true;
    this.ghostUnselected = true;
    this.highlightVisibility = {
      boundary: true, nonManifold: true, flipped: true, intersecting: true,
    };

    this.#buildLights();
    this.#buildPlate();

    this.resize();
    this.#observeResize();
    this.#animate();
  }

  #buildLights() {
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.5));
    const key = new THREE.DirectionalLight(0xffffff, 1.45);
    key.position.set(0.6, -1, 1.4);
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0x9dbcff, 0.5);
    fill.position.set(-1.2, 0.8, 0.5);
    this.scene.add(fill);
    const rim = new THREE.DirectionalLight(0xffffff, 0.25);
    rim.position.set(0.3, 0.6, -1);
    this.scene.add(rim);
  }

  #buildPlate() {
    if (this.plate) {
      this.scene.remove(this.plate);
      this.plate.traverse((o) => o.geometry && o.geometry.dispose());
    }
    const size = this.plateSize;
    const group = new THREE.Group();

    const grid = new THREE.GridHelper(size, Math.max(4, Math.round(size / 10)), 0x2f3b4d, 0x1d2530);
    grid.rotation.x = Math.PI / 2;
    grid.material.transparent = true;
    grid.material.opacity = 0.85;
    group.add(grid);

    const surface = new THREE.Mesh(
      new THREE.PlaneGeometry(size, size),
      new THREE.MeshBasicMaterial({ color: 0x151b24, transparent: true, opacity: 0.6 }),
    );
    surface.position.z = -0.05;
    group.add(surface);

    const border = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.PlaneGeometry(size, size)),
      new THREE.LineBasicMaterial({ color: 0x4a6285 }),
    );
    group.add(border);

    // A small origin marker: X red, Y green, so orientation is never in doubt.
    const axes = new THREE.AxesHelper(size * 0.08);
    axes.position.set(-size / 2, -size / 2, 0.01);
    group.add(axes);

    this.plate = group;
    this.scene.add(group);
  }

  setPlateSize(size) {
    this.plateSize = size;
    this.#buildPlate();
  }

  #observeResize() {
    const observer = new ResizeObserver(() => this.resize());
    observer.observe(this.canvas.parentElement);
  }

  resize() {
    const parent = this.canvas.parentElement;
    const width = Math.max(1, parent.clientWidth);
    const height = Math.max(1, parent.clientHeight);
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  #animate = () => {
    requestAnimationFrame(this.#animate);
    this.#advanceTween();
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  };

  /**
   * Move the camera over time rather than teleporting it.
   *
   * Cutting straight to a new viewpoint loses people: the model appears to jump
   * to a different shape, and it takes a moment to work out that it is the same
   * object seen from somewhere else. Travelling there keeps the connection.
   */
  #advanceTween() {
    if (!this.tween) return;
    const t = (performance.now() - this.tween.start) / this.tween.duration;
    if (t >= 1) {
      this.camera.position.copy(this.tween.toPosition);
      this.controls.target.copy(this.tween.toTarget);
      this.tween = null;
      this.controls.update();
      return;
    }
    // ease in and out, so it sets off and arrives gently
    const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    this.camera.position.lerpVectors(this.tween.fromPosition, this.tween.toPosition, e);
    this.controls.target.lerpVectors(this.tween.fromTarget, this.tween.toTarget, e);
  }

  #makeGeometry(buffers) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(buffers.position, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(buffers.normal, 3));
    geometry.computeBoundingSphere();
    geometry.computeBoundingBox();
    return geometry;
  }

  addModel(id, buffers) {
    this.removeModel(id);
    const group = new THREE.Group();
    const geometry = this.#makeGeometry(buffers);

    const material = new THREE.MeshStandardMaterial({
      color: 0xb9c6d6, metalness: 0.08, roughness: 0.62, side: THREE.FrontSide,
    });
    const mesh = new THREE.Mesh(geometry, material);
    group.add(mesh);

    // Anything you can see of this one is a face pointing the wrong way. A
    // muted crimson, deliberately: the bright red is spoken for by the hole
    // outlines, and the two must not be mistaken for each other.
    // Nudged away from the camera so it cannot bleed through at the silhouette,
    // where front and back faces would otherwise land on the same depth value.
    const backMaterial = new THREE.MeshBasicMaterial({
      color: 0x9e2436, side: THREE.BackSide,
      polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 2,
    });
    const backMesh = new THREE.Mesh(geometry, backMaterial);
    backMesh.visible = this.showBackfaces;
    group.add(backMesh);

    const wireframe = new THREE.LineSegments(
      new THREE.WireframeGeometry(geometry),
      new THREE.LineBasicMaterial({ color: 0x66788f, transparent: true, opacity: 0.35 }),
    );
    wireframe.visible = this.showWireframe;
    group.add(wireframe);

    const overlays = {};
    this.scene.add(group);
    this.models.set(id, { group, mesh, backMesh, wireframe, geometry, overlays });
    return group;
  }

  updateModel(id, buffers) {
    const entry = this.models.get(id);
    if (!entry) return this.addModel(id, buffers);
    const geometry = this.#makeGeometry(buffers);
    entry.mesh.geometry = geometry;
    entry.backMesh.geometry = geometry;
    entry.wireframe.geometry.dispose();
    entry.wireframe.geometry = new THREE.WireframeGeometry(geometry);
    entry.geometry.dispose();
    entry.geometry = geometry;
    this.clearHighlights(id);
    if (id === this.selectedId) this.#drawSelection();
    return entry.group;
  }

  removeModel(id) {
    const entry = this.models.get(id);
    if (!entry) return;
    this.clearHighlights(id);
    this.scene.remove(entry.group);
    entry.geometry.dispose();
    entry.wireframe.geometry.dispose();
    entry.mesh.material.dispose();
    entry.backMesh.material.dispose();
    entry.wireframe.material.dispose();
    this.models.delete(id);
    if (id === this.selectedId) this.selectedId = null;
    this.#drawSelection();
  }

  setModelVisible(id, visible) {
    const entry = this.models.get(id);
    if (entry) entry.group.visible = visible;
    this.#drawSelection();
  }

  #isGhosted(id) {
    return this.ghostUnselected && this.models.size > 1 && id !== this.selectedId;
  }

  setWireframe(on) {
    this.showWireframe = on;
    for (const [key, entry] of this.models) entry.wireframe.visible = on && !this.#isGhosted(key);
  }

  setBackfaceHighlight(on) {
    this.showBackfaces = on;
    for (const [key, entry] of this.models) entry.backMesh.visible = on && !this.#isGhosted(key);
  }

  setGhostUnselected(on) {
    this.ghostUnselected = on;
    this.setSelected(this.selectedId);
  }

  clearHighlights(id) {
    const entry = this.models.get(id);
    if (!entry) return;
    for (const key of Object.keys(entry.overlays)) {
      const object = entry.overlays[key];
      entry.group.remove(object);
      object.geometry.dispose();
      object.material.dispose();
      delete entry.overlays[key];
    }
  }

  /**
   * Overlays are drawn with depth testing off so a hole on the far side of the
   * model is still findable — which is the whole point of looking for it.
   */
  setHighlights(id, buffers) {
    const entry = this.models.get(id);
    if (!entry) return;
    this.clearHighlights(id);

    const addLines = (key, data, colour) => {
      if (!data || data.length === 0) return;
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(data, 3));
      const object = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({
        color: colour, depthTest: false, transparent: true, opacity: 0.95,
      }));
      object.renderOrder = 10;
      object.visible = this.highlightVisibility[key];
      entry.group.add(object);
      entry.overlays[key] = object;
    };

    const addFaces = (key, data, colour) => {
      if (!data || data.length === 0) return;
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(data, 3));
      geometry.computeVertexNormals();
      const object = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({
        color: colour, side: THREE.DoubleSide, transparent: true, opacity: 0.8,
        depthTest: true, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3,
      }));
      object.renderOrder = 9;
      object.visible = this.highlightVisibility[key];
      entry.group.add(object);
      entry.overlays[key] = object;
    };

    addFaces('flipped', buffers.flipped, HIGHLIGHT_COLOURS.flipped);
    addFaces('intersecting', buffers.intersecting, HIGHLIGHT_COLOURS.intersecting);
    addLines('nonManifold', buffers.nonManifold, HIGHLIGHT_COLOURS.nonManifold);
    addLines('boundary', buffers.boundary, HIGHLIGHT_COLOURS.boundary);
  }

  setHighlightVisible(key, visible) {
    this.highlightVisibility[key] = visible;
    for (const entry of this.models.values()) {
      const object = entry.overlays[key];
      if (object) object.visible = visible;
    }
  }

  /**
   * Mark a model as the selected one: corner brackets around it, and everything
   * else knocked back a shade so the answer is obvious at a glance.
   */
  setSelected(id) {
    this.selectedId = id;
    const many = this.models.size > 1 && this.ghostUnselected;
    for (const [key, entry] of this.models) {
      const ghost = many && key !== id;
      const material = entry.mesh.material;
      material.color.setHex(ghost ? 0x8b97a6 : 0xb9c6d6);
      // Ghost the others rather than merely dimming them. A selected part is
      // very often tucked inside or behind its neighbour — which is generally
      // why it needed separating — and a solid neighbour hides the very thing
      // the selection was meant to point at.
      material.transparent = ghost;
      material.opacity = ghost ? 0.18 : 1;
      material.depthWrite = !ghost;
      material.needsUpdate = true;
      entry.mesh.renderOrder = ghost ? 1 : 0;
      entry.backMesh.visible = this.showBackfaces && !ghost;
      entry.wireframe.visible = this.showWireframe && !ghost;
    }
    this.#drawSelection();
  }

  #drawSelection() {
    if (this.selectionMarker) {
      this.scene.remove(this.selectionMarker);
      this.selectionMarker.geometry.dispose();
      this.selectionMarker.material.dispose();
      this.selectionMarker = null;
    }
    const entry = this.models.get(this.selectedId);
    if (!entry || !entry.group.visible || this.models.size < 2) return;

    const box = new THREE.Box3().setFromObject(entry.mesh);
    if (box.isEmpty()) return;
    const size = box.getSize(new THREE.Vector3());
    // Brackets rather than a full cage: they read as a selection instead of
    // being mistaken for part of the model.
    const arm = Math.max(Math.min(size.x, size.y, size.z) * 0.22, size.length() * 0.04);
    const pad = size.length() * 0.02;
    const min = [box.min.x - pad, box.min.y - pad, box.min.z - pad];
    const max = [box.max.x + pad, box.max.y + pad, box.max.z + pad];

    const points = [];
    for (let corner = 0; corner < 8; corner++) {
      const origin = [
        corner & 1 ? max[0] : min[0],
        corner & 2 ? max[1] : min[1],
        corner & 4 ? max[2] : min[2],
      ];
      const towards = [corner & 1 ? -1 : 1, corner & 2 ? -1 : 1, corner & 4 ? -1 : 1];
      for (let axis = 0; axis < 3; axis++) {
        const end = origin.slice();
        end[axis] += towards[axis] * Math.min(arm, (max[axis] - min[axis]) / 2);
        points.push(origin[0], origin[1], origin[2], end[0], end[1], end[2]);
      }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(points), 3));
    this.selectionMarker = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({
      color: SELECTION_COLOUR, depthTest: false, transparent: true, opacity: 0.95,
    }));
    this.selectionMarker.renderOrder = 20;
    this.scene.add(this.selectionMarker);
  }

  /** Bounding box of one model, or null if it is not loaded or hidden. */
  boundsOfModel(id) {
    const entry = this.models.get(id);
    if (!entry || !entry.group.visible) return null;
    const box = new THREE.Box3().setFromObject(entry.mesh);
    return box.isEmpty() ? null : box;
  }

  /** Travel to a viewpoint that frames the given box. */
  #travelTo(box, padding, duration) {
    const size = box.getSize(new THREE.Vector3());
    const centre = box.getCenter(new THREE.Vector3());
    const radius = Math.max(size.length() / 2, 1e-3);
    const distance = (radius * padding) / Math.sin((this.camera.fov * Math.PI) / 360);

    // Approach from where the camera already is, so the model does not appear
    // to spin on its own when all that happened was a change of selection.
    let direction = this.camera.position.clone().sub(this.controls.target);
    if (direction.lengthSq() < 1e-9) direction = new THREE.Vector3(0.62, -0.86, 0.58);
    direction.normalize();

    const toPosition = centre.clone().addScaledVector(direction, distance);
    this.camera.near = Math.max(distance / 1000, 0.001);
    this.camera.far = distance * 100;
    this.camera.updateProjectionMatrix();

    if (duration <= 0) {
      this.camera.position.copy(toPosition);
      this.controls.target.copy(centre);
      this.controls.update();
      this.tween = null;
      return;
    }
    this.tween = {
      fromPosition: this.camera.position.clone(),
      toPosition,
      fromTarget: this.controls.target.clone(),
      toTarget: centre,
      start: performance.now(),
      duration,
    };
  }

  /** Bring one model into view. */
  frameModel(id, { padding = 2.4, duration = 480 } = {}) {
    const box = this.boundsOfModel(id);
    if (!box) return false;
    this.#travelTo(box, padding, duration);
    return true;
  }

  boundsOfAll() {
    const box = new THREE.Box3();
    let any = false;
    for (const entry of this.models.values()) {
      if (!entry.group.visible) continue;
      box.expandByObject(entry.mesh);
      any = true;
    }
    return any ? box : null;
  }

  frameAll(padding = 1.5, duration = 0) {
    const box = this.boundsOfAll();
    if (!box) return;
    if (duration <= 0) {
      // A fresh view: come back to the standard three-quarter angle.
      const size = box.getSize(new THREE.Vector3());
      const centre = box.getCenter(new THREE.Vector3());
      const radius = Math.max(size.length() / 2, 1e-3);
      const distance = (radius * padding) / Math.sin((this.camera.fov * Math.PI) / 360);
      const direction = new THREE.Vector3(0.62, -0.86, 0.58).normalize();
      this.camera.position.copy(centre).addScaledVector(direction, distance);
      this.camera.near = Math.max(distance / 1000, 0.001);
      this.camera.far = distance * 100;
      this.camera.updateProjectionMatrix();
      this.controls.target.copy(centre);
      this.controls.update();
      this.tween = null;
      return;
    }
    this.#travelTo(box, padding, duration);
  }

  setView(name) {
    const box = this.boundsOfAll();
    const centre = box ? box.getCenter(new THREE.Vector3()) : new THREE.Vector3();
    const distance = this.camera.position.distanceTo(this.controls.target) || 300;
    const directions = {
      front: [0, -1, 0], back: [0, 1, 0],
      left: [-1, 0, 0], right: [1, 0, 0],
      top: [0, 0, 1], bottom: [0, 0, -1],
      iso: [0.62, -0.86, 0.58],
    };
    const d = directions[name] || directions.iso;
    const direction = new THREE.Vector3(d[0], d[1], d[2]).normalize();
    this.camera.position.copy(centre).addScaledVector(direction, distance);
    // Looking straight down needs a different up vector or the view degenerates.
    this.camera.up.set(0, 0, 1);
    if (name === 'top') this.camera.up.set(0, 1, 0);
    if (name === 'bottom') this.camera.up.set(0, -1, 0);
    this.controls.target.copy(centre);
    this.controls.update();
  }
}
