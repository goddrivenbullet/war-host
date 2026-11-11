// Scene, camera, lights, sky and battlefield meshes.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { WATER_LEVEL, RIM_HEIGHT } from '../sim/terrain.js';
import { part, merge, treeGeometry, rockGeometry } from './models.js';
import { makeRng } from '../sim/rng.js';

export function createStage(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  const haze = new THREE.Color('#d8c2a0');
  scene.fog = new THREE.Fog(haze, 450, 1500);
  scene.background = haze;

  const camera = new THREE.PerspectiveCamera(48, 1, 1, 4000);
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minDistance = 15;
  controls.maxDistance = 900;
  controls.maxPolarAngle = Math.PI * 0.47;
  controls.screenSpacePanning = false;
  controls.zoomSpeed = 1.2;
  controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };

  // sky dome: warm horizon, deep blue zenith
  const skyGeo = new THREE.SphereGeometry(2500, 24, 12);
  const skyMat = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: { top: { value: new THREE.Color('#5d86b8') }, mid: { value: new THREE.Color('#e9c999') }, bottom: { value: haze } },
    vertexShader: 'varying vec3 vP; void main(){ vP = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader: 'uniform vec3 top; uniform vec3 mid; uniform vec3 bottom; varying vec3 vP; void main(){ float h = vP.y; vec3 c = h > 0.0 ? mix(mid, top, smoothstep(0.0, 0.45, h)) : bottom; gl_FragColor = vec4(c,1.0); }',
  });
  const sky = new THREE.Mesh(skyGeo, skyMat);
  sky.renderOrder = -1;
  scene.add(sky);

  const hemi = new THREE.HemisphereLight('#c9d8f0', '#6b5a3a', 1.1);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight('#ffd49a', 2.6);
  sun.position.set(-320, 210, -160);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const sc = sun.shadow.camera;
  sc.left = -330; sc.right = 330; sc.top = 330; sc.bottom = -330; sc.near = 10; sc.far = 1200;
  sun.shadow.bias = -0.0008;
  sun.shadow.normalBias = 0.6;
  scene.add(sun, sun.target);

  const resize = () => {
    const w = canvas.clientWidth || window.innerWidth, h = canvas.clientHeight || window.innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  window.addEventListener('resize', resize);
  resize();

  return { renderer, scene, camera, controls, sun, resize };
}

function detailTexture() {
  const s = 256;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const g = c.getContext('2d');
  const img = g.createImageData(s, s);
  const rng = makeRng(42);
  for (let i = 0; i < s * s; i++) {
    const v = 200 + rng() * 55;
    img.data[i * 4] = v; img.data[i * 4 + 1] = v; img.data[i * 4 + 2] = v; img.data[i * 4 + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  // a few grass strokes
  g.globalAlpha = 0.25;
  for (let i = 0; i < 900; i++) {
    g.strokeStyle = rng() < 0.5 ? '#ffffff' : '#9a9a9a';
    const x = rng() * s, y = rng() * s;
    g.beginPath(); g.moveTo(x, y); g.lineTo(x + rng() * 3 - 1.5, y - 3 - rng() * 4); g.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

let sharedDetail = null;

/** Build all static meshes for a battlefield; returns a group plus wall handles. */
export function buildField(terrain, seed = 1) {
  const group = new THREE.Group();
  const { n, res, half, heights, map } = terrain;
  const size = terrain.size;
  const geo = new THREE.PlaneGeometry(size, size, n - 1, n - 1);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  const grass = new THREE.Color(map.grass), grass2 = new THREE.Color(map.grass).offsetHSL(0.03, 0.05, 0.07);
  const earth = new THREE.Color(map.earth), rock = new THREE.Color('#8d877a'), sand = new THREE.Color('#b8a47a'), mud = new THREE.Color('#5d5040');
  const c = new THREE.Color();
  const rng = makeRng(seed + 99);
  const noise = new Float32Array(n * n);
  for (let i = 0; i < noise.length; i++) noise[i] = rng();
  for (let k = 0; k < pos.count; k++) {
    const i = k % n, j = (k / n) | 0;
    const h = heights[i + j * n];
    pos.setY(k, h);
    const x = -half + i * res, z = -half + j * res;
    const hx = heights[Math.min(n - 1, i + 1) + j * n] - heights[Math.max(0, i - 1) + j * n];
    const hz = heights[i + Math.min(n - 1, j + 1) * n] - heights[i + Math.max(0, j - 1) * n];
    const slope = Math.hypot(hx, hz) / (2 * res);
    const nz = (Math.sin(x * 0.031) + Math.sin(z * 0.027 + 2) + Math.sin((x + z) * 0.013)) / 3;
    c.copy(grass).lerp(grass2, 0.5 + 0.5 * nz);
    c.lerp(earth, Math.min(1, Math.max(0, (noise[k % noise.length] - 0.82) * 3)) * 0.6);
    if (slope > 0.35) c.lerp(rock, Math.min(1, (slope - 0.35) * 2));
    if (terrain.kind === 'river') {
      const d = Math.abs(z - terrain.riverZ(x));
      if (d < terrain.riverHalf + 9) c.lerp(sand, Math.min(1, (terrain.riverHalf + 9 - d) / 8));
      if (h < WATER_LEVEL) c.lerp(mud, 0.7);
    }
    if (terrain.kind === 'castle') {
      if (Math.abs(x) < 6 + Math.abs(z - terrain.wallZ) * 0.01) c.lerp(earth, 0.65);
      if (Math.abs(z - terrain.wallZ) < 9) c.lerp(earth, 0.35);
    }
    // trampled deployment ground
    const g = map.startGap / 2;
    if (Math.abs(Math.abs(z) - g - 40) < 70 && Math.abs(x) < 260) c.lerp(earth, 0.12);
    const v = 0.92 + noise[(k * 7) % noise.length] * 0.12;
    colors[k * 3] = c.r * v; colors[k * 3 + 1] = c.g * v; colors[k * 3 + 2] = c.b * v;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  if (!sharedDetail) sharedDetail = detailTexture();
  const tex = sharedDetail;
  // repeat UVs so the grain is fine
  const uv = geo.attributes.uv;
  for (let k = 0; k < uv.count; k++) uv.setXY(k, uv.getX(k) * 160, uv.getY(k) * 160);
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true, map: tex });
  const ground = new THREE.Mesh(geo, mat);
  ground.receiveShadow = true;
  group.add(ground);
  // distant countryside so the field does not end at a cliff
  const far = 4000;
  const outerParts = [
    [far * 2, far - half, 0, -(half + (far - half) / 2)],
    [far * 2, far - half, 0, half + (far - half) / 2],
    [far - half, size, -(half + (far - half) / 2), 0],
    [far - half, size, half + (far - half) / 2, 0],
  ].map(([w, d, x, z]) => { const g = new THREE.PlaneGeometry(w, d); g.rotateX(-Math.PI / 2); g.translate(x, 0, z); return g; });
  const outer = new THREE.Mesh(merge(outerParts.map((g) => part(g, '#ffffff'))), new THREE.MeshLambertMaterial({ color: new THREE.Color(map.grass).multiplyScalar(0.8) }));
  outer.position.y = RIM_HEIGHT - 1.5;
  group.add(outer);

  // water
  if (terrain.kind === 'river') {
    // a ribbon of water that follows the river bed
    const wgeo = new THREE.PlaneGeometry(size, terrain.riverHalf * 2 + 26, 240, 1);
    wgeo.rotateX(-Math.PI / 2);
    const wp = wgeo.attributes.position;
    for (let k = 0; k < wp.count; k++) wp.setZ(k, wp.getZ(k) + terrain.riverZ(wp.getX(k)));
    const water = new THREE.Mesh(wgeo, new THREE.MeshPhongMaterial({ color: '#4e7d93', transparent: true, opacity: 0.82, shininess: 90, specular: '#f5deb0' }));
    water.position.y = WATER_LEVEL;
    group.add(water);
    // ford markers: small stakes either side
    const stakes = [];
    for (const f of terrain.fords) for (const s of [-1, 1]) for (const e of [-1, 1]) {
      const x = f.x + e * (f.half - 2), z = terrain.riverZ(x) + s * (terrain.riverHalf + 4);
      stakes.push(part(new THREE.CylinderGeometry(0.15, 0.15, 2.2, 5), '#6b4a2b', [x, terrain.heightAt(x, z) + 1.1, z]));
      stakes.push(part(new THREE.BoxGeometry(0.05, 0.5, 0.8), '#d9c27a', [x, terrain.heightAt(x, z) + 2.0, z + 0.4]));
    }
    if (stakes.length) group.add(new THREE.Mesh(merge(stakes), new THREE.MeshLambertMaterial({ vertexColors: true })));
  }

  // walls
  const wallMeshes = [];
  if (terrain.kind === 'castle') {
    const stone = new THREE.MeshLambertMaterial({ color: '#a39d8f' });
    const gateMat = new THREE.MeshLambertMaterial({ color: '#6a4b2c' });
    const rubbleMat = new THREE.MeshLambertMaterial({ color: '#8e887b' });
    for (const W of terrain.walls) {
      const len = W.x1 - W.x0, cx = (W.x0 + W.x1) / 2, cz = (W.z0 + W.z1) / 2;
      const base = Math.min(terrain.heightAt(W.x0, cz), terrain.heightAt(W.x1, cz), terrain.heightAt(cx, cz)) - 1;
      const parts = [part(new THREE.BoxGeometry(len, W.height + 1, W.z1 - W.z0), W.gate ? '#6a4b2c' : '#a39d8f', [0, (W.height + 1) / 2, 0])];
      if (!W.gate) {
        for (let x = -len / 2 + 1; x < len / 2 - 0.5; x += 2.4) parts.push(part(new THREE.BoxGeometry(1.2, 1.2, 1.0), '#9b9586', [x, W.height + 1.6, -Math.sign(terrain.wallZ) * ((W.z1 - W.z0) / 2 - 0.5)]));
      } else {
        parts.push(part(new THREE.BoxGeometry(len + 2, 2, (W.z1 - W.z0) + 1), '#a39d8f', [0, W.height + 1.5, 0]));
      }
      const mesh = new THREE.Mesh(merge(parts), new THREE.MeshLambertMaterial({ vertexColors: true }));
      mesh.position.set(cx, base, cz);
      mesh.castShadow = true; mesh.receiveShadow = true;
      const rubble = new THREE.Mesh(new THREE.DodecahedronGeometry(1, 0), rubbleMat);
      rubble.scale.set(len * 0.45, 1.6, 4);
      rubble.position.set(cx, base + 0.6, cz);
      rubble.visible = false;
      group.add(mesh, rubble);
      wallMeshes.push({ wall: W, mesh, rubble, baseY: base });
    }
    // towers at segment joints, outside the passable gaps
    const tParts = [];
    for (const W of terrain.walls) {
      if (W.gate) {
        for (const x of [W.x0 - 2, W.x1 + 2]) tParts.push(part(new THREE.CylinderGeometry(4, 4.5, 15, 8), '#a8a294', [x, terrain.heightAt(x, terrain.wallZ) + 6.5, terrain.wallZ]));
      }
    }
    // keep in the distance
    const kz = terrain.wallZ + Math.sign(terrain.wallZ) * 330;
    tParts.push(part(new THREE.BoxGeometry(40, 26, 40), '#a8a294', [0, terrain.heightAt(0, kz) + 12, kz]));
    for (const [dx, dz] of [[-22, -22], [22, -22], [-22, 22], [22, 22]]) tParts.push(part(new THREE.CylinderGeometry(6, 6.5, 34, 8), '#b0aa9c', [dx, terrain.heightAt(0, kz) + 16, kz + dz]));
    tParts.push(part(new THREE.ConeGeometry(7, 10, 8), '#5a3d2e', [22, terrain.heightAt(0, kz) + 38, kz + 22]));
    tParts.push(part(new THREE.ConeGeometry(7, 10, 8), '#5a3d2e', [-22, terrain.heightAt(0, kz) + 38, kz + 22]));
    const towers = new THREE.Mesh(merge(tParts), new THREE.MeshLambertMaterial({ vertexColors: true }));
    towers.castShadow = true;
    group.add(towers);
    void stone; void gateMat;
  }

  // trees and rocks on the edges, away from the lines
  const trng = makeRng(seed * 31 + 5);
  const treeGeo = treeGeometry();
  const tmat = new THREE.MeshLambertMaterial({ vertexColors: true });
  const nTrees = 420;
  const trees = new THREE.InstancedMesh(treeGeo, tmat, nTrees);
  const rocks = new THREE.InstancedMesh(rockGeometry(), tmat, 120);
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), v = new THREE.Vector3(), s = new THREE.Vector3();
  let placed = 0, tries = 0;
  while (placed < nTrees && tries++ < 8000) {
    const x = (trng() * 2 - 1) * (half - 20), z = (trng() * 2 - 1) * (half - 20);
    const inField = Math.abs(x) < 330 && Math.abs(z) < 290;
    if (inField) continue;
    if (terrain.kind === 'river' && Math.abs(z - terrain.riverZ(x)) < terrain.riverHalf + 6) continue;
    if (terrain.kind === 'castle' && Math.abs(z - terrain.wallZ) < 12) continue;
    const sc = 0.8 + trng() * 0.7;
    m4.compose(v.set(x, terrain.heightAt(x, z) - 0.3, z), q.setFromEuler(e.set(0, trng() * 6.28, 0)), s.set(sc, sc * (0.9 + trng() * 0.3), sc));
    trees.setMatrixAt(placed++, m4);
  }
  trees.count = placed;
  for (let k = 0; k < 120; k++) {
    let x, z;
    do { x = (trng() * 2 - 1) * (half - 30); z = (trng() * 2 - 1) * (half - 30); } while (Math.abs(x) < 300 && Math.abs(z) < 280);
    const sc = 0.6 + trng() * 1.6;
    m4.compose(v.set(x, terrain.heightAt(x, z) - 0.2, z), q.setFromEuler(e.set(trng(), trng() * 6.28, 0)), s.set(sc, sc, sc));
    rocks.setMatrixAt(k, m4);
  }
  trees.castShadow = true;
  group.add(trees, rocks);

  return {
    group, wallMeshes,
    dispose() {
      group.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material && o.material.map !== sharedDetail) o.material.dispose?.(); });
    },
  };
}
