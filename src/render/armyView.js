// Draws the battle: instanced troops, engines, banners, projectiles, effects.
import * as THREE from 'three';
import { troopGeometry, trebuchetModel, catapultModel, ballistaModel, bannerGeometry, part, merge } from './models.js';
import { S_DEAD, S_FIGHT, S_ROUT, S_FLED, T_TREB, T_CAT, T_BAL, P_ARROW, P_STONE, P_BOLT, TYPE_NAMES } from '../sim/battle.js';
import { TROOP_TYPES } from '../sim/army.js';

export const TEAM = ['#b3262e', '#3f6f9f'];
const UNIT_SCALE = 1.18;
const CORPSE_TIME = 70;

function writeMatrix(arr, o, x, y, z, yaw, pitch, s) {
  const c = Math.cos(yaw), sn = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
  arr[o] = c * s; arr[o + 1] = 0; arr[o + 2] = -sn * s; arr[o + 3] = 0;
  arr[o + 4] = sn * sp * s; arr[o + 5] = cp * s; arr[o + 6] = c * sp * s; arr[o + 7] = 0;
  arr[o + 8] = sn * cp * s; arr[o + 9] = -sp * s; arr[o + 10] = c * cp * s; arr[o + 11] = 0;
  arr[o + 12] = x; arr[o + 13] = y; arr[o + 14] = z; arr[o + 15] = 1;
}

export class ArmyView {
  constructor(scene, battle, fieldHandles, opts = {}) {
    this.scene = scene;
    this.battle = battle;
    this.field = fieldHandles;
    this.group = new THREE.Group();
    scene.add(this.group);
    this.shadows = opts.shadows ?? true;
    const data = battle.data;
    const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
    this.mat = mat;

    // one instanced mesh per side per troop type
    this.troopMeshes = [];
    for (let s = 0; s < 2; s++) {
      const army = battle.sides[s].army;
      for (const typeName of TROOP_TYPES) {
        const type = TYPE_NAMES.indexOf(typeName);
        const ids = [];
        for (let i = 0; i < battle.N; i++) if (battle.sd[i] === s && battle.ut[i] === type) ids.push(i);
        if (!ids.length) continue;
        const geo = troopGeometry(typeName, army.loadouts[typeName], data, TEAM[s]);
        const mesh = new THREE.InstancedMesh(geo, mat, ids.length);
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(ids.length * 3).fill(1), 3);
        mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
        mesh.frustumCulled = false;
        mesh.castShadow = this.shadows;
        mesh.receiveShadow = false;
        this.group.add(mesh);
        this.troopMeshes.push({ mesh, ids: Int32Array.from(ids), mounted: typeName === 'cavalry' || typeName === 'horseArchers' });
      }
    }

    // engines: individual models (there are only a few)
    this.engines = [];
    const builders = { [T_TREB]: trebuchetModel, [T_CAT]: catapultModel, [T_BAL]: ballistaModel };
    const engCache = {};
    for (let i = 0; i < battle.N; i++) {
      const t = battle.ut[i];
      if (!builders[t]) continue;
      const s = battle.sd[i];
      const key = t + ':' + s;
      engCache[key] ||= builders[t](TEAM[s]);
      const m = engCache[key];
      const root = new THREE.Group();
      const yawG = new THREE.Group();
      const base = new THREE.Mesh(m.base, mat);
      const pivot = new THREE.Group();
      pivot.position.set(0, m.pivotY, m.pivotZ || 0);
      const arm = new THREE.Mesh(m.arm, mat);
      pivot.add(arm);
      pivot.rotation.x = m.rest;
      yawG.add(base, pivot);
      root.add(yawG);
      base.castShadow = arm.castShadow = true;
      this.group.add(root);
      this.engines.push({ i, root, yawG, pivot, model: m, type: t });
    }

    // banners: one per regiment
    const bg = bannerGeometry();
    const poleMesh = new THREE.InstancedMesh(bg.pole, mat, battle.regs.length);
    poleMesh.frustumCulled = false;
    this.group.add(poleMesh);
    this.poles = poleMesh;
    this.flags = [0, 1].map((s) => {
      const fm = new THREE.InstancedMesh(bg.flag, new THREE.MeshLambertMaterial({ color: TEAM[s], side: THREE.DoubleSide }), battle.regs.length);
      fm.frustumCulled = false;
      this.group.add(fm);
      return fm;
    });
    this.bannerPos = battle.regs.map((r) => ({ x: r.cx, z: r.cz }));

    // projectiles
    const arrowGeo = merge([part(new THREE.BoxGeometry(0.05, 0.05, 1.0), '#3b2f22'), part(new THREE.BoxGeometry(0.02, 0.12, 0.2), '#e8e0cc', [0, 0, -0.45])]);
    this.arrows = new THREE.InstancedMesh(arrowGeo, mat, 9000);
    this.arrows.frustumCulled = false; this.arrows.count = 0;
    this.stones = new THREE.InstancedMesh(new THREE.DodecahedronGeometry(0.9, 0), new THREE.MeshLambertMaterial({ color: '#6f6a60' }), 400);
    this.stones.frustumCulled = false; this.stones.count = 0;
    const boltGeo = merge([part(new THREE.BoxGeometry(0.1, 0.1, 2.4), '#4a3826'), part(new THREE.ConeGeometry(0.12, 0.4, 4), '#9aa1a8', [0, 0, 1.3], [Math.PI / 2, 0, 0])]);
    this.bolts = new THREE.InstancedMesh(boltGeo, mat, 400);
    this.bolts.frustumCulled = false; this.bolts.count = 0;
    this.group.add(this.arrows, this.stones, this.bolts);

    // dust puffs for heavy impacts
    this.puffs = [];
    const puffGeo = new THREE.IcosahedronGeometry(1, 1);
    for (let k = 0; k < 40; k++) {
      const m = new THREE.Mesh(puffGeo, new THREE.MeshLambertMaterial({ color: '#b9a582', transparent: true, opacity: 0, depthWrite: false }));
      m.visible = false;
      this.group.add(m);
      this.puffs.push({ m, t0: -99, size: 1 });
    }
    this.puffIdx = 0;
    this.lastEvent = -1;
    this.onEvent = opts.onEvent || null;
  }

  setShadows(on) {
    this.shadows = on;
    for (const t of this.troopMeshes) t.mesh.castShadow = on;
  }

  update(alpha, now) {
    const b = this.battle, T = b.terrain;
    const X = b.x, Z = b.z, PX = b.px, PZ = b.pz, st = b.st, hd = b.hd, phd = b.phd;
    const simT = b.t;
    // troops
    for (const tm of this.troopMeshes) {
      const arr = tm.mesh.instanceMatrix.array;
      const col = tm.mesh.instanceColor.array;
      let k = 0;
      const ids = tm.ids;
      for (let q = 0; q < ids.length; q++) {
        const i = ids[q];
        const s = st[i];
        if (s === S_FLED) continue;
        const x = PX[i] + (X[i] - PX[i]) * alpha, z = PZ[i] + (Z[i] - PZ[i]) * alpha;
        let y = T.heightAt(x, z);
        let d = hd[i] - phd[i];
        if (d > Math.PI) d -= 2 * Math.PI; else if (d < -Math.PI) d += 2 * Math.PI;
        const yaw = phd[i] + d * alpha;
        let pitch = 0, shade = 1;
        if (s === S_DEAD) {
          const age = simT - b.deadT[i];
          if (age > CORPSE_TIME + 10) continue;
          pitch = Math.min(1, age / 0.7) * 1.45 * (i & 1 ? 1 : -1);
          if (tm.mounted) pitch *= 0.9;
          y -= age > CORPSE_TIME ? (age - CORPSE_TIME) * 0.25 : 0;
          y += 0.15;
          shade = 0.55;
        } else {
          const sp = Math.hypot(b.vx[i], b.vz[i]);
          if (sp > 0.4) y += Math.abs(Math.sin(now * (tm.mounted ? 9 : 11) + i * 1.7)) * (tm.mounted ? 0.18 : 0.1);
          if (s === S_FIGHT) { pitch = Math.sin(now * 7 + i) * 0.08; shade = 1.05; }
          if (s === S_ROUT) shade = 0.82;
        }
        writeMatrix(arr, k * 16, x, y, z, yaw, pitch, UNIT_SCALE);
        col[k * 3] = shade; col[k * 3 + 1] = shade; col[k * 3 + 2] = shade;
        k++;
      }
      tm.mesh.count = k;
      tm.mesh.instanceMatrix.needsUpdate = true;
      tm.mesh.instanceColor.needsUpdate = true;
    }

    // engines
    for (const e of this.engines) {
      const i = e.i;
      const x = X[i], z = Z[i];
      e.root.position.set(x, T.heightAt(x, z), z);
      e.yawG.rotation.y = hd[i];
      if (st[i] === S_DEAD) {
        e.root.rotation.z = Math.min(0.5, (simT - b.deadT[i]) * 0.5);
        e.root.position.y -= Math.min(1.2, (simT - b.deadT[i]) * 0.3);
        continue;
      }
      const since = simT - b.fireT[i];
      const m = e.model;
      if (!m.yawOnly) {
        const fire = since < 0.5 ? since / 0.5 : since < 3 ? 1 - (since - 0.5) / 2.5 : 0;
        e.pivot.rotation.x = m.rest + (m.fired - m.rest) * Math.max(0, fire);
      } else {
        e.pivot.children[0].position.z = since < 0.2 ? 0.4 : 0;
      }
    }

    // banners follow regiment centres
    const parr = this.poles.instanceMatrix.array;
    const counts = [0, 0];
    let pk = 0;
    for (const r of b.regs) {
      const bp = this.bannerPos[r.id];
      if (r.kind === 'engine' || r.alive === 0 || r.routing) continue;
      // put the standard just behind the regiment's front
      const tx = r.cx, tz = r.cz;
      if (Math.abs(tx - bp.x) + Math.abs(tz - bp.z) > 40) { bp.x = tx; bp.z = tz; }
      else { bp.x += (tx - bp.x) * 0.06; bp.z += (tz - bp.z) * 0.06; }
      const y = T.heightAt(bp.x, bp.z);
      writeMatrix(parr, pk * 16, bp.x, y, bp.z, r.heading, 0, 1.4);
      pk++;
      const fm = this.flags[r.side];
      const sway = Math.sin(now * 2 + r.id) * 0.25 + (r.side ? Math.PI : 0) + Math.PI / 2;
      writeMatrix(fm.instanceMatrix.array, counts[r.side]++ * 16, bp.x, y, bp.z, sway, 0, 1.4);
    }
    this.poles.count = pk; this.poles.instanceMatrix.needsUpdate = true;
    for (let s = 0; s < 2; s++) { this.flags[s].count = counts[s]; this.flags[s].instanceMatrix.needsUpdate = true; }

    // projectiles
    const tNow = simT - (1 - alpha) * (1 / 20);
    let na = 0, ns = 0, nb = 0;
    const aArr = this.arrows.instanceMatrix.array, sArr = this.stones.instanceMatrix.array, bArr = this.bolts.instanceMatrix.array;
    for (let k = 0; k < b.pCount; k++) {
      let u = (tNow - b.pt0[k]) / b.pdur[k];
      if (u < 0) continue; if (u > 1) u = 1;
      const sx = b.psx[k], sy = b.psy[k], sz = b.psz[k], ex = b.pex[k], ey = b.pey[k] + 0.3, ez = b.pez[k];
      const apex = b.papex[k];
      const x = sx + (ex - sx) * u, z = sz + (ez - sz) * u;
      const y = sy + (ey - sy) * u + 4 * apex * u * (1 - u);
      const dx = ex - sx, dz = ez - sz, dy = (ey - sy) + 4 * apex * (1 - 2 * u);
      const yaw = Math.atan2(dx, dz), pitch = -Math.atan2(dy, Math.hypot(dx, dz));
      const kind = b.pk[k];
      if (kind === P_ARROW) { if (na < 9000) writeMatrix(aArr, (na++) * 16, x, y, z, yaw, pitch, 1.4); }
      else if (kind === P_STONE) { if (ns < 400) writeMatrix(sArr, (ns++) * 16, x, y, z, u * 9, u * 5, 1); }
      else if (kind === P_BOLT) { if (nb < 400) writeMatrix(bArr, (nb++) * 16, x, y, z, yaw, pitch, 1); }
    }
    this.arrows.count = na; this.stones.count = ns; this.bolts.count = nb;
    this.arrows.instanceMatrix.needsUpdate = true; this.stones.instanceMatrix.needsUpdate = true; this.bolts.instanceMatrix.needsUpdate = true;

    // events -> effects
    for (const ev of b.events) {
      if (ev.seq <= this.lastEvent) continue;
      this.lastEvent = ev.seq;
      if (ev.type === 'stone' || ev.type === 'breach' || ev.type === 'engineDown') this._puff(ev.x, ev.z, ev.type === 'breach' ? 9 : ev.type === 'stone' ? 4 : 5, simT);
      if (ev.type === 'breach') this._breach(ev.extra);
      if (this.onEvent) this.onEvent(ev);
    }
    for (const p of this.puffs) {
      if (!p.m.visible) continue;
      const age = simT - p.t0;
      if (age > 2.2 || age < 0) { p.m.visible = false; continue; }
      const s = p.size * (0.6 + age * 1.3);
      p.m.scale.set(s, s * 0.6, s);
      p.m.material.opacity = 0.55 * (1 - age / 2.2);
    }
    // walls lose height as they are battered
    if (this.field) for (const w of this.field.wallMeshes) {
      if (!w.wall.alive) continue;
      const f = 0.65 + 0.35 * (w.wall.hp / w.wall.maxHp);
      w.mesh.scale.y = f;
    }
  }

  _puff(x, z, size, t) {
    const p = this.puffs[this.puffIdx++ % this.puffs.length];
    p.t0 = t; p.size = size;
    p.m.position.set(x, this.battle.terrain.heightAt(x, z) + 0.5, z);
    p.m.visible = true;
  }

  _breach(id) {
    if (!this.field) return;
    const w = this.field.wallMeshes.find((m) => m.wall.id === id);
    if (w) { w.mesh.visible = false; w.rubble.visible = true; }
  }

  dispose() {
    this.scene.remove(this.group);
    this.group.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
    for (const f of this.flags) f.material.dispose();
    for (const p of this.puffs) p.m.material.dispose();
    this.stones.material.dispose();
    this.mat.dispose();
  }
}
