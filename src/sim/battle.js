// War Host battle simulation.
// Fixed timestep, seeded RNG, struct-of-arrays storage, per-side spatial hash.
// No rendering code here: the renderer only reads the public arrays.
import { makeRng } from './rng.js';
import { createTerrain } from './terrain.js';
import { TROOP_TYPES, ENGINE_TYPES } from './army.js';

export const DT = 1 / 20;
export const TYPE_NAMES = [...TROOP_TYPES, ...ENGINE_TYPES];
export const T_INF = 0, T_ARCH = 1, T_CAV = 2, T_HA = 3, T_TREB = 4, T_CAT = 5, T_BAL = 6;
export const S_DEAD = 0, S_FORM = 1, S_FIGHT = 2, S_ROUT = 3, S_FLED = 4;
export const P_ARROW = 0, P_STONE = 1, P_BOLT = 2;
export const TIME_LIMIT = 900;

const CELL = 4;
const MAX_PROJ = 16000;
const AI_EVERY = 10; // ticks (0.5 s)

const DAGGER = { damage: 8, reach: 1.1, interval: 1.2, pierce: 0.2, vsMounted: 1, charge: 1 };
const RIDER_BLADE = { damage: 13, reach: 1.5, interval: 1.0, pierce: 0.25, vsMounted: 1, charge: 1.4 };

const alive = (s) => s === S_FORM || s === S_FIGHT;
const present = (s) => s === S_FORM || s === S_FIGHT || s === S_ROUT;
const angDiff = (a, b) => { let d = b - a; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return d; };
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

export class Battle {
  /**
   * @param {object} o
   * @param {object} o.data      { units, weapons, armor, styles, maps }
   * @param {string} o.mapId
   * @param {object[]} o.armies  two validated army objects
   * @param {number} [o.seed]
   * @param {number} [o.troops]  total troops for both sides (engines extra)
   * @param {number} [o.defender] side holding the castle on the castle map
   */
  constructor(o) {
    this.data = o.data;
    this.seed = o.seed ?? 1;
    this.rng = makeRng(this.seed);
    this.mapId = o.mapId;
    this.map = o.data.maps[o.mapId];
    if (!this.map) throw new Error('Unknown map ' + o.mapId);
    this.defender = o.defender ?? 1;
    this.terrain = createTerrain(this.map, { seed: this.seed, defender: this.defender });
    this.t = 0; this.tick = 0;
    this.ended = false; this.result = null; this.endT = 0;
    this.events = []; this.eventSeq = 0;
    this.sides = [0, 1].map((s) => ({
      index: s, dir: s === 0 ? 1 : -1, army: structuredClone(o.armies[s]),
      styleId: o.armies[s].style, style: o.data.styles[o.armies[s].style],
      start: 0, dead: 0, fled: 0, fighting: 0, lastMeleeT: 0, feintT: -1, broken: false,
      cx: 0, cz: 0, minX: 0, maxX: 0, engagedInf: 0,
    }));
    this.regs = [];
    this._deploy(o.troops ?? 10000);
    this._initGrids();
    this._initProjectiles();
    this._ai(); // initial orders
  }

  // ------------------------------------------------------------------ setup
  _deploy(totalTroops) {
    const perSide = Math.max(100, Math.round(totalTroops / 2));
    const specs = [];
    for (const side of this.sides) {
      const comp = side.army.composition;
      const sum = TROOP_TYPES.reduce((a, t) => a + (comp[t] || 0), 0) || 1;
      const counts = TROOP_TYPES.map((t) => Math.floor(perSide * (comp[t] || 0) / sum));
      let rem = perSide - counts.reduce((a, b) => a + b, 0);
      for (let k = 0, guard = 0; rem > 0 && guard < 1000; k = (k + 1) % 4, guard++) if ((comp[TROOP_TYPES[k]] || 0) > 0) { counts[k]++; rem--; }
      specs.push(counts);
    }
    // Count units first to size arrays.
    let N = 0;
    for (let s = 0; s < 2; s++) {
      N += specs[s].reduce((a, b) => a + b, 0);
      for (const e of ENGINE_TYPES) N += this.sides[s].army.engines[e] || 0;
    }
    this.N = N;
    this.x = new Float32Array(N); this.z = new Float32Array(N);
    this.px = new Float32Array(N); this.pz = new Float32Array(N);
    this.vx = new Float32Array(N); this.vz = new Float32Array(N);
    this.hd = new Float32Array(N); this.phd = new Float32Array(N);
    this.hp = new Float32Array(N); this.cd = new Float32Array(N);
    this.chg = new Float32Array(N); this.deadT = new Float32Array(N);
    this.fireT = new Float32Array(N).fill(-99);
    this.st = new Uint8Array(N); this.ut = new Uint8Array(N); this.sd = new Uint8Array(N);
    this.rg = new Uint16Array(N); this.tg = new Int32Array(N).fill(-1); this.slot = new Int32Array(N);
    this.radius = new Float32Array(N);
    this.sepX = new Float32Array(N); this.sepZ = new Float32Array(N);

    let next = 0;
    for (let s = 0; s < 2; s++) next = this._layoutSide(this.sides[s], specs[s], next);
    this.px.set(this.x); this.pz.set(this.z); this.phd.set(this.hd);
  }

  _makeReg(side, typeName, count) {
    const D = this.data;
    const u = D.units[typeName];
    const type = TYPE_NAMES.indexOf(typeName);
    const reg = {
      id: this.regs.length, side: side.index, type, typeName, kind: u.kind, mounted: !!u.mounted,
      units: [], start: count, alive: count, routing: false, label: u.label,
      ax: 0, az: 0, heading: side.dir > 0 ? 0 : Math.PI, goalX: 0, goalZ: 0, faceX: null, faceZ: null,
      homeX: 0, homeZ: 0, backX: 0, backZ: 0, wing: 0, moveSpeed: 0, pass: false,
      cx: 0, cz: 0, engaged: 0, recentLoss: 0, rearHits: 0, missileHits: 0,
      fireReg: -1, wallTarget: -1, phase: 'start', phaseT: 0, forced: false,
      cols: 1, colsEff: 1, depth: 4, sx: 1, sz: 1, cosH: 1, sinH: 0,
    };
    if (u.kind === 'engine') {
      Object.assign(reg, {
        hp: u.hp, radius: u.radius, walk: 0, run: 0, armorDef: u.armor, blockMelee: 0, blockMissile: 0,
        range: u.range, minRange: u.minRange, reload: u.reload, dmg: u.damage, splash: u.splash || 0,
        pierceCount: u.pierce || 0, proj: u.projectile === 'bolt' ? P_BOLT : P_STONE, projSpeed: u.speed,
        morale: 999, maxMorale: 999, attackMul: 1, defMul: 1, engageR: 0, leash: 0,
        dmgMelee: 0, reach: 0, interval: 1, pierce: 0.5, vsMounted: 1, chargeMul: 1,
      });
    } else {
      const lo = side.army.loadouts[typeName];
      const w = D.weapons[lo.weapon], a = D.armor.armor[lo.armor], sh = D.armor.shields[lo.shield];
      const armorSpeed = reg.mounted ? Math.sqrt(a.speed) : a.speed;
      const mul = armorSpeed * sh.speed * (w.speed || 1);
      const melee = w.class === 'melee' ? w : (reg.mounted ? RIDER_BLADE : DAGGER);
      Object.assign(reg, {
        loadout: { ...lo }, hp: u.hp, radius: u.radius, walk: u.walk * mul, run: u.run * mul,
        armorDef: a.defense, blockMelee: sh.melee, blockMissile: sh.missile,
        dmgMelee: melee.damage, reach: melee.reach, interval: melee.interval, pierce: melee.pierce,
        vsMounted: melee.vsMounted, chargeMul: melee.charge, spear: lo.weapon === 'spear',
        range: w.class === 'missile' ? w.range : 0, missileDmg: w.damage || 0, missilePierce: w.pierce || 0,
        missileInterval: w.interval || 0, accuracy: w.accuracy || 0, arc: w.arc || 0.3,
        // defenders behind a castle wall hold their nerve a little better
        baseMorale: u.morale + a.morale + (this.terrain.kind === 'castle' && this.defender === side.index ? 12 : 0),
      });
    }
    this.regs.push(reg);
    this._applyStyle(reg, side.style, true);
    return reg;
  }

  _applyStyle(reg, style, initial = false) {
    const side = this.sides[reg.side];
    reg.forced = false;
    reg.phase = 'start'; reg.phaseT = this.t; reg.pass = false;
    reg.attackMul = 1; reg.defMul = 1; reg.speedMul = 1; reg.fireRate = 1; reg.priority = 'nearest'; reg.delay = 0;
    if (reg.kind === 'engine') {
      reg.priority = style.engines.target; reg.reloadMul = style.engines.reload || 1;
      reg.mode = 'engine';
      return;
    }
    if (reg.type === T_INF) {
      const m = style.infantry;
      Object.assign(reg, { mode: m.mode, attackMul: m.attack, defMul: m.defense, speedMul: m.speed,
        engageBase: m.engage, leash: m.leash, delay: m.delay || 0 });
      reg.depth = style.formation.depth; reg.sx = reg.sz = style.formation.spacing;
    } else if (reg.type === T_ARCH) {
      const m = style.archers;
      Object.assign(reg, { mode: m.mode, fireRate: m.fireRate || 1, priority: m.target, engageBase: 3.5, leash: 6 });
      reg.depth = 4; reg.sx = 1.5; reg.sz = 1.7;
    } else if (reg.type === T_CAV) {
      const m = style.cavalry;
      Object.assign(reg, { mode: m.mode, delay: m.delay || 0, priority: m.target, engageBase: 10, leash: 70 });
      reg.depth = 4; reg.sx = 2.3; reg.sz = 3.3;
    } else if (reg.type === T_HA) {
      const m = style.horseArchers;
      Object.assign(reg, { mode: m.mode, priority: 'nearest', engageBase: 4, leash: 12 });
      reg.depth = 3; reg.sx = 2.6; reg.sz = 3.5;
    }
    reg.engageR = reg.engageBase;
    const mb = (style.morale || 0);
    if (initial) { reg.morale = reg.baseMorale + mb; reg.maxMorale = reg.morale; }
    else { reg.maxMorale = reg.baseMorale + mb; reg.morale = Math.min(reg.morale, reg.maxMorale); }
    reg.cols = Math.max(1, Math.ceil(Math.max(reg.alive, 1) / reg.depth));
    reg.colsEff = reg.cols;
    if (!initial && reg.mode === 'feint') reg.phase = 'start';
    void side;
  }

  _layoutSide(side, counts, next) {
    const T = this.terrain;
    const d = side.dir;
    const isCastle = T.kind === 'castle';
    const defending = isCastle && this.defender === side.index;
    const zFront = defending ? T.wallZ - d * 24 : -d * (this.map.startGap / 2);
    const toW = (lx, lf) => [lx * d, zFront + d * lf];
    const style = side.style;
    const groups = {};
    TROOP_TYPES.forEach((t, k) => {
      const c = counts[k];
      groups[t] = [];
      if (c <= 0) return;
      const size = this.data.units[t].regimentSize;
      const nRegs = Math.max(1, Math.round(c / size));
      for (let r = 0; r < nRegs; r++) {
        const cnt = Math.floor(c / nRegs) + (r < c % nRegs ? 1 : 0);
        if (cnt > 0) groups[t].push(this._makeReg(side, t, cnt));
      }
    });
    const width = (reg) => (reg.cols - 1) * reg.sx;
    const depthLen = (reg) => (Math.ceil(reg.start / reg.cols) - 1) * reg.sz;
    const placeRow = (regs, lf0, maxW, gap) => {
      // place regs in lines centred on lx = 0; returns depth used
      let lf = lf0, used = 0;
      let i = 0;
      while (i < regs.length) {
        const line = []; let w = 0;
        while (i < regs.length && (line.length === 0 || w + gap + width(regs[i]) <= maxW)) {
          w += (line.length ? gap : 0) + width(regs[i]); line.push(regs[i]); i++;
        }
        let x = -w / 2; let dl = 0;
        for (const r of line) {
          const cx = x + width(r) / 2;
          this._setHome(r, toW(cx, lf), side);
          x += width(r) + gap; dl = Math.max(dl, depthLen(r));
        }
        lf -= dl + 16; used += dl + 16;
      }
      return used;
    };
    const infDepth = placeRow(groups.infantry, 0, 380, 5);
    let backLf = -infDepth - 4;
    if (style.formation.archers === 'front') {
      placeRow(groups.archers, 26, 440, 6);
      // remember fallback position behind the infantry
      const tmp = groups.archers.map((r) => [r.homeX, r.homeZ]);
      const used = placeRow(groups.archers, backLf, 440, 6);
      groups.archers.forEach((r, k) => { r.backX = r.homeX; r.backZ = r.homeZ; this._setHome(r, tmp[k], side, true); });
      backLf -= used;
    } else {
      backLf -= placeRow(groups.archers, backLf, 440, 6);
      groups.archers.forEach((r) => { r.backX = r.homeX; r.backZ = r.homeZ; });
    }
    const infHalf = Math.max(60, ...groups.infantry.map((r) => Math.abs(r.homeX) + width(r) / 2));
    const maxHalf = this.terrain.half - 50;
    const wings = (regs, startHalf, lf0) => {
      // fill each wing outward; wrap into a new rank behind when we reach the map edge
      const st = [{ x: startHalf + 14, lf: lf0, dl: 0 }, { x: startHalf + 14, lf: lf0, dl: 0 }];
      let outerX = startHalf;
      regs.forEach((r, k) => {
        const w = width(r), sdx = k % 2;
        const S = st[sdx];
        if (S.x + w > maxHalf && S.x > startHalf + 14) { S.lf -= S.dl + 12; S.x = Math.min(startHalf + 14, maxHalf - w); S.dl = 0; }
        const cx = Math.min(S.x + w / 2, maxHalf - w / 2);
        const sign = sdx === 0 ? 1 : -1;
        this._setHome(r, toW(sign * cx, S.lf), side);
        r.wing = sign * d;
        S.x += w + 10; S.dl = Math.max(S.dl, depthLen(r));
        outerX = Math.max(outerX, Math.min(S.x, maxHalf));
      });
      const minLf = Math.min(st[0].lf - st[0].dl, st[1].lf - st[1].dl);
      return { outer: outerX, minLf };
    };
    let haStart = infHalf, haLf = -8;
    if (style.formation.cavalry === 'rear') {
      backLf -= placeRow(groups.cavalry, backLf - 6, 420, 10);
      groups.cavalry.forEach((r) => { r.wing = Math.sign(r.homeX) || 1; });
    } else if (groups.cavalry.length) {
      const w = wings(groups.cavalry, infHalf, -4);
      if (w.outer < maxHalf - 70) haStart = w.outer; else haLf = w.minLf - 16;
    }
    wings(groups.horseArchers, haStart, haLf);
    for (const r of [...groups.horseArchers]) { r.backX = r.homeX; r.backZ = r.homeZ; }

    // Engines: a battery per type, in a line behind the army.
    let engLf = backLf - 30;
    if (isCastle && !defending) {
      const want = T.wallZ - d * 215; // close enough for catapults to reach the wall
      engLf = (want - zFront) / d;
    }
    const engines = [];
    for (const e of ENGINE_TYPES) {
      const c = side.army.engines[e] || 0;
      if (c > 0) { const reg = this._makeReg(side, e, c); engines.push(reg); }
    }
    const totalEng = engines.reduce((a, r) => a + r.start, 0);
    let ek = 0;

    // Spawn troop units at their slots.
    for (const reg of this.regs) {
      if (reg.side !== side.index) continue;
      if (reg.kind === 'engine') {
        for (let k = 0; k < reg.start; k++) {
          const lx = (ek - (totalEng - 1) / 2) * 26 + (ek % 2) * 6;
          const [wx, wz] = toW(lx, engLf - (ek % 2) * 10);
          ek++;
          const i = next++;
          this._spawn(i, reg, wx, wz, k);
          this.ut[i] = reg.type;
        }
        reg.ax = reg.homeX = 0; reg.az = reg.homeZ = toW(0, engLf)[1];
        continue;
      }
      reg.cosH = Math.cos(reg.heading); reg.sinH = Math.sin(reg.heading);
      for (let k = 0; k < reg.start; k++) {
        const i = next++;
        const p = this._slotPos(reg, k);
        this._spawn(i, reg, p[0] + this.rng.gauss() * 0.15, p[1] + this.rng.gauss() * 0.15, k);
      }
    }
    side.start = this.regs.filter((r) => r.side === side.index && r.kind !== 'engine').reduce((a, r) => a + r.start, 0);
    return next;
  }

  _setHome(reg, [x, z], side, keepBack = false) {
    reg.homeX = reg.ax = reg.goalX = x;
    reg.homeZ = reg.az = reg.goalZ = z;
    reg.heading = side.dir > 0 ? 0 : Math.PI;
    reg.cosH = Math.cos(reg.heading); reg.sinH = Math.sin(reg.heading);
    if (!keepBack) { reg.backX = x; reg.backZ = z; }
  }

  _spawn(i, reg, x, z, k) {
    const T = this.terrain;
    // nudge out of blocked spots
    let tries = 0;
    while (T.blocked(x, z, reg.radius) && tries++ < 40) z -= this.sides[reg.side].dir * 1.5;
    this.x[i] = x; this.z[i] = z;
    this.hd[i] = reg.heading;
    this.hp[i] = reg.hp; this.st[i] = S_FORM; this.ut[i] = reg.type; this.sd[i] = reg.side;
    this.rg[i] = reg.id; this.slot[i] = k; this.radius[i] = reg.radius;
    this.cd[i] = reg.kind === 'engine' ? this.rng.range(1, reg.reload) : this.rng.range(0, 2);
    reg.units.push(i);
  }

  _slotPos(reg, k, out = [0, 0]) {
    const cols = reg.colsEff;
    const col = k % cols, row = (k / cols) | 0;
    const lx = (col - (cols - 1) / 2) * reg.sx;
    const lf = -row * reg.sz;
    // forward f = (sin h, cos h), right r = (cos h, -sin h)
    out[0] = reg.ax + reg.cosH * lx + reg.sinH * lf;
    out[1] = reg.az - reg.sinH * lx + reg.cosH * lf;
    return out;
  }

  _initGrids() {
    const half = this.terrain.half;
    this.gHalf = half;
    this.G = Math.ceil((half * 2) / CELL) + 1;
    const cells = this.G * this.G;
    this.gStart = [new Int32Array(cells + 1), new Int32Array(cells + 1)];
    this.gItems = [new Int32Array(this.N), new Int32Array(this.N)];
    this.gCell = new Int32Array(this.N);
    this.gFill = new Int32Array(cells);
  }

  _initProjectiles() {
    const P = MAX_PROJ;
    this.pCount = 0;
    this.pk = new Uint8Array(P); this.ps = new Uint8Array(P);
    this.psx = new Float32Array(P); this.psy = new Float32Array(P); this.psz = new Float32Array(P);
    this.pex = new Float32Array(P); this.pey = new Float32Array(P); this.pez = new Float32Array(P);
    this.pt0 = new Float32Array(P); this.pdur = new Float32Array(P); this.papex = new Float32Array(P);
    this.pdmg = new Float32Array(P); this.ppierce = new Float32Array(P); this.psplash = new Float32Array(P);
    this.pn = new Uint8Array(P);
  }

  _cellIndex(x, z) {
    const G = this.G;
    let cx = ((x + this.gHalf) / CELL) | 0, cz = ((z + this.gHalf) / CELL) | 0;
    if (cx < 0) cx = 0; else if (cx >= G) cx = G - 1;
    if (cz < 0) cz = 0; else if (cz >= G) cz = G - 1;
    return cx + cz * G;
  }

  _buildGrids() {
    const N = this.N, st = this.st, sd = this.sd, cell = this.gCell;
    for (let s = 0; s < 2; s++) {
      const start = this.gStart[s];
      start.fill(0);
    }
    for (let i = 0; i < N; i++) {
      if (!present(st[i])) { cell[i] = -1; continue; }
      const c = this._cellIndex(this.x[i], this.z[i]);
      cell[i] = c;
      this.gStart[sd[i]][c + 1]++;
    }
    for (let s = 0; s < 2; s++) {
      const start = this.gStart[s];
      for (let c = 1; c < start.length; c++) start[c] += start[c - 1];
      const fill = this.gFill; fill.fill(0);
      const items = this.gItems[s];
      for (let i = 0; i < N; i++) {
        if (sd[i] !== s || cell[i] < 0) continue;
        const c = cell[i];
        items[start[c] + fill[c]++] = i;
      }
    }
  }

  /** nearest unit of side `s` within r of (x,z), or -1 */
  _nearest(s, x, z, r, skipRouting = false) {
    const G = this.G, start = this.gStart[s], items = this.gItems[s];
    const X = this.x, Z = this.z, st = this.st;
    const c0x = Math.max(0, ((x - r + this.gHalf) / CELL) | 0), c1x = Math.min(G - 1, ((x + r + this.gHalf) / CELL) | 0);
    const c0z = Math.max(0, ((z - r + this.gHalf) / CELL) | 0), c1z = Math.min(G - 1, ((z + r + this.gHalf) / CELL) | 0);
    let best = -1, bestD = r * r;
    for (let cz = c0z; cz <= c1z; cz++) {
      for (let cx = c0x; cx <= c1x; cx++) {
        const c = cx + cz * G;
        for (let k = start[c], e = start[c + 1]; k < e; k++) {
          const j = items[k];
          if (skipRouting && st[j] === S_ROUT) continue;
          const dx = X[j] - x, dz = Z[j] - z;
          const d2 = dx * dx + dz * dz;
          if (d2 < bestD) { bestD = d2; best = j; }
        }
      }
    }
    return best;
  }

  _forRadius(s, x, z, r, fn) {
    const G = this.G, start = this.gStart[s], items = this.gItems[s];
    const c0x = Math.max(0, ((x - r + this.gHalf) / CELL) | 0), c1x = Math.min(G - 1, ((x + r + this.gHalf) / CELL) | 0);
    const c0z = Math.max(0, ((z - r + this.gHalf) / CELL) | 0), c1z = Math.min(G - 1, ((z + r + this.gHalf) / CELL) | 0);
    for (let cz = c0z; cz <= c1z; cz++) for (let cx = c0x; cx <= c1x; cx++) {
      const c = cx + cz * G;
      for (let k = start[c], e = start[c + 1]; k < e; k++) {
        const j = items[k];
        const dx = this.x[j] - x, dz = this.z[j] - z;
        const rr = r + this.radius[j];
        if (dx * dx + dz * dz <= rr * rr) fn(j, Math.sqrt(dx * dx + dz * dz));
      }
    }
  }

  // ------------------------------------------------------------------ public
  setStyle(sideIndex, styleId) {
    const style = this.data.styles[styleId];
    if (!style) return;
    const side = this.sides[sideIndex];
    side.styleId = styleId; side.style = style;
    for (const r of this.regs) if (r.side === sideIndex && !r.routing) this._applyStyle(r, style, false);
    this._ai();
  }

  pushEvent(type, x, z, extra = 0) {
    this.events.push({ seq: this.eventSeq++, type, x, z, t: this.t, extra });
    if (this.events.length > 256) this.events.splice(0, this.events.length - 256);
  }

  step() {
    this.tick++; this.t += DT;
    this.px.set(this.x); this.pz.set(this.z); this.phd.set(this.hd);
    this._buildGrids();
    if (this.tick % AI_EVERY === 0) this._ai();
    this._moveAnchors();
    this._updateUnits();
    this._separateAndMove();
    this._updateProjectiles();
  }

  // ------------------------------------------------------------------ AI
  _ai() {
    const regs = this.regs, st = this.st, X = this.x, Z = this.z;
    // 1. regiment statistics
    for (const r of regs) {
      let n = 0, sx = 0, sz = 0, eng = 0;
      for (const i of r.units) {
        const s = st[i];
        if (s === S_FORM || s === S_FIGHT) { n++; sx += X[i]; sz += Z[i]; if (s === S_FIGHT) eng++; }
      }
      r.alive = n; r.engaged = eng;
      if (n > 0) { r.cx = sx / n; r.cz = sz / n; }
    }
    for (const side of this.sides) {
      let n = 0, sx = 0, sz = 0, mn = Infinity, mx = -Infinity, ei = 0;
      for (const r of regs) {
        if (r.side !== side.index || r.kind === 'engine' || r.routing || r.alive === 0) continue;
        n += r.alive; sx += r.cx * r.alive; sz += r.cz * r.alive;
        const hw = (r.colsEff * r.sx) / 2;
        mn = Math.min(mn, r.cx - hw); mx = Math.max(mx, r.cx + hw);
        if (r.type === T_INF && r.engaged > r.alive * 0.15) ei++;
      }
      side.fighting = n; side.engagedInf = ei;
      if (n > 0) { side.cx = sx / n; side.cz = sz / n; side.minX = mn; side.maxX = mx; }
    }
    // 2. morale & rout
    for (const r of regs) {
      if (r.kind === 'engine' || r.routing) continue;
      const side = this.sides[r.side];
      const lossFrac = r.recentLoss / r.start;
      const planned = r.phase === 'fall'; // a feigned retreat is drilled: rear hits sting less
      r.morale -= lossFrac * (planned ? 120 : 240);
      r.morale -= Math.min(4, r.rearHits * (planned ? 0.05 : 0.3));
      r.morale -= Math.min(1.5, r.missileHits * 0.012);
      const cas = 1 - r.alive / r.start;
      if (cas > 0.35) r.morale -= (cas - 0.35) * 2.5;
      const sideCas = 1 - side.fighting / Math.max(1, side.start);
      if (sideCas > 0.45) r.morale -= (sideCas - 0.45) * 4;
      if (r.recentLoss === 0 && r.engaged === 0) r.morale = Math.min(r.maxMorale, r.morale + 0.5);
      r.recentLoss = 0; r.rearHits = 0; r.missileHits = 0;
      if (r.alive === 0 || r.morale <= 0 || r.alive < r.start * 0.15) this._rout(r);
    }
    // 3. stalemate breaker: nobody has crossed blades for a long while
    const lastMelee = Math.max(this.sides[0].lastMeleeT, this.sides[1].lastMeleeT);
    const stale = this.t > 75 && this.t - lastMelee > 75;
    // 4. orders
    for (const r of regs) {
      if (r.routing || r.alive === 0) continue;
      if (stale && !r.forced && (r.mode === 'hold' || r.mode === 'delayed' || r.mode === 'reserve' || r.mode === 'ambush')) {
        r.forced = true; r.mode = r.type === T_INF ? 'advance' : r.type === T_CAV ? 'charge' : r.mode;
      }
      this._orders(r);
    }
    // 5. close ranks every 3 s
    if (this.tick % (AI_EVERY * 6) === 0) this._compactSlots();
    // 6. end of battle
    this._checkEnd();
  }

  _rout(r) {
    if (r.routing) return;
    r.routing = true;
    for (const i of r.units) if (alive(this.st[i])) { this.st[i] = S_ROUT; this.tg[i] = -1; }
    this.pushEvent('rout', r.cx, r.cz, r.side);
    for (const o of this.regs) {
      if (o.side !== r.side || o.routing || o.kind === 'engine') continue;
      const d = Math.hypot(o.cx - r.cx, o.cz - r.cz);
      if (d < 80) o.morale -= 7 * (1 - d / 80) + 2;
    }
  }

  _compactSlots() {
    for (const r of this.regs) {
      if (r.kind === 'engine' || r.routing) continue;
      let k = 0;
      for (const i of r.units) if (alive(this.st[i])) this.slot[i] = k++;
      r.cols = Math.max(1, Math.ceil(Math.max(k, 1) / r.depth));
    }
  }

  _enemyRegs(r, fn) {
    for (const o of this.regs) if (o.side !== r.side && !o.routing && o.alive > 0 && o.kind !== 'engine') fn(o);
  }

  _pickTarget(r, priority, maxD = Infinity) {
    let best = null, bestS = Infinity;
    const want = priority === 'archers' ? [T_ARCH, T_HA] : priority === 'cavalry' ? [T_CAV, T_HA] : priority === 'infantry' ? [T_INF] : null;
    this._enemyRegs(r, (o) => {
      const d = Math.hypot(o.cx - r.cx, o.cz - r.cz);
      if (d > maxD) return;
      const s = d * (want && want.includes(o.type) ? 0.5 : 1);
      if (s < bestS) { bestS = s; best = o; }
    });
    return best;
  }

  _orders(r) {
    const side = this.sides[r.side];
    const enemy = this.sides[1 - r.side];
    const t = this.t;
    const near = this._pickTarget(r, 'nearest');
    const nearD = near ? Math.hypot(near.cx - r.cx, near.cz - r.cz) : Infinity;
    const fwdX = Math.sin(r.heading), fwdZ = Math.cos(r.heading);
    r.faceX = near ? near.cx : null; r.faceZ = near ? near.cz : null;

    const hold = (x = r.homeX, z = r.homeZ) => { r.goalX = x; r.goalZ = z; r.moveSpeed = r.walk * 0.9; };
    const go = (o, speed) => {
      if (!o) { hold(r.ax, r.az); return; }
      // stop pushing the anchor once most of the regiment is fighting
      if (r.engaged > r.alive * 0.3) { r.goalX = r.ax; r.goalZ = r.az; r.moveSpeed = speed; return; }
      r.goalX = o.cx; r.goalZ = o.cz; r.moveSpeed = speed;
    };

    if (r.kind === 'engine') {
      r.wallTarget = -1; r.fireReg = -1;
      const T = this.terrain;
      const breaches = T.walls.filter((W) => !W.alive).length;
      if (r.priority === 'walls' && T.kind === 'castle' && this.defender !== r.side && breaches < 2) {
        let best = -1, bd = Infinity;
        for (const W of T.walls) {
          if (!W.alive) continue;
          const d = Math.abs((W.x0 + W.x1) / 2 - (enemy.cx || 0)) + (W.gate ? -60 : 0);
          if (d < bd) { bd = d; best = W.id; }
        }
        if (best >= 0) { r.wallTarget = best; return; }
      }
      // densest enemy regiment (prefer big blocks of foot)
      let best = null, bs = -1;
      this._enemyRegs(r, (o) => {
        const s = o.alive * (o.type === T_INF ? 1.4 : o.type === T_ARCH ? 1.2 : 0.7);
        if (s > bs) { bs = s; best = o; }
      });
      r.fireReg = best ? best.id : -1;
      return;
    }

    // missile targeting for archers / horse archers
    if (r.range > 0) {
      const hb = 1.25;
      const tgt = this._pickTarget(r, r.priority, r.range * hb);
      r.fireReg = tgt ? tgt.id : -1;
    }

    if (r.type === T_INF) {
      r.engageR = r.engageBase;
      switch (r.mode) {
        case 'hold':
          hold();
          if (nearD < 18) r.engageR = Math.max(r.engageBase, 5);
          break;
        case 'delayed':
          if (t > r.delay || nearD < 60) { r.mode = 'advance'; }
          hold();
          break;
        case 'charge':
          go(near, r.run * 0.78 * r.speedMul);
          break;
        case 'advance':
          if (nearD < 40) { go(near, r.run * 0.85 * r.speedMul); r.engageR = Math.max(r.engageBase, 11); }
          else go(near, r.walk * r.speedMul);
          break;
        case 'feint':
          if (r.phase === 'start' || r.phase === 'advance') {
            r.phase = 'advance';
            go(near, r.walk * r.speedMul);
            if (nearD < 34) { r.phase = 'fall'; r.phaseT = t; side.feintT = t; this.pushEvent('feint', r.cx, r.cz, r.side); }
          } else if (r.phase === 'fall') {
            r.engageR = 0;
            r.goalX = r.cx - fwdX * 80; r.goalZ = r.cz - fwdZ * 80; r.moveSpeed = r.run * 0.9;
            r.faceX = r.goalX; r.faceZ = r.goalZ;
            if (t - r.phaseT > 10) { r.phase = 'turn'; r.phaseT = t; r.attackMul = 1.45; }
          } else if (r.phase === 'turn') {
            go(near, r.run * 0.85); r.engageR = 14;
            if (t - r.phaseT > 20) { r.phase = 'done'; r.attackMul = side.style.infantry.attack; }
          } else {
            go(near, nearD < 40 ? r.run * 0.8 : r.walk); r.engageR = 10;
          }
          break;
        default: hold();
      }
      return;
    }

    if (r.type === T_ARCH) {
      r.engageR = 3.5;
      switch (r.mode) {
        case 'screen':
          if (r.phase !== 'back') {
            hold();
            let threat = false;
            this._enemyRegs(r, (o) => { if (o.kind === 'melee' && Math.hypot(o.cx - r.cx, o.cz - r.cz) < 60) threat = true; });
            if (threat) { r.phase = 'back'; r.pass = true; }
          }
          if (r.phase === 'back') {
            r.goalX = r.backX; r.goalZ = r.backZ; r.moveSpeed = r.run * 0.9;
            if (Math.hypot(r.ax - r.backX, r.az - r.backZ) < 3) { r.pass = false; r.mode = 'hold'; r.homeX = r.backX; r.homeZ = r.backZ; }
          }
          break;
        case 'advance':
          if (near && nearD > r.range * 0.75 && nearD < 1e6) { r.goalX = near.cx; r.goalZ = near.cz; r.moveSpeed = r.walk; }
          else hold(r.ax, r.az);
          break;
        default: hold();
      }
      return;
    }

    if (r.type === T_CAV) {
      r.engageR = 10;
      const charge = (o) => { go(o, r.run * 0.9); r.engageR = 13; };
      // Lance cavalry pulls back and charges again after a long melee.
      if (r.phase === 'withdraw') {
        r.engageR = 0;
        r.goalX = r.cx - fwdX * 70; r.goalZ = r.cz - fwdZ * 70; r.moveSpeed = r.run * 0.7;
        r.faceX = null;
        if (t - r.phaseT > 7) { r.phase = 'strike'; r.phaseT = t; }
        return;
      }
      if (r.chargeMul >= 2.5 && r.engaged > r.alive * 0.4 && r.phase === 'strike' && t - r.phaseT > 12) {
        r.phase = 'withdraw'; r.phaseT = t; return;
      }
      switch (r.mode) {
        case 'charge': {
          const o = this._pickTarget(r, r.priority);
          if (r.phase !== 'strike') { r.phase = 'strike'; r.phaseT = t; }
          if (o && Math.hypot(o.cx - r.cx, o.cz - r.cz) < 140) charge(o); else go(o, r.walk * 1.4);
          break;
        }
        case 'reserve':
        case 'ambush': {
          const trigger = (r.mode === 'ambush' && side.feintT > 0 && t - side.feintT > 3) ||
            (t > r.delay && (side.engagedInf > 0 || r.mode === 'ambush')) || nearD < 85;
          if (r.phase === 'strike' || trigger) {
            if (r.phase !== 'strike') { r.phase = 'strike'; r.phaseT = t; }
            // prefer enemy regiments already locked with our foot
            let o = null, bd = Infinity;
            this._enemyRegs(r, (e) => {
              const d = Math.hypot(e.cx - r.cx, e.cz - r.cz) * (e.engaged > 0 ? 0.6 : 1) * (r.priority === 'cavalry' && (e.type === T_CAV || e.type === T_HA) ? 0.5 : 1);
              if (d < bd) { bd = d; o = e; }
            });
            charge(o);
          } else hold();
          break;
        }
        case 'flank':
        default: {
          if (t < r.delay) { hold(); break; }
          if (r.phase === 'start') { r.phase = 'ride'; r.phaseT = t; }
          if (r.phase === 'ride') {
            const half = this.terrain.half - 40;
            const fx = clamp(r.wing > 0 ? enemy.maxX + 55 : enemy.minX - 55, -half, half);
            const fz = clamp(enemy.cz - enemy.dir * 45, -half, half);
            r.goalX = fx; r.goalZ = fz; r.moveSpeed = r.run * 0.62; r.faceX = null;
            if (Math.hypot(r.cx - fx, r.cz - fz) < 40 || t - r.phaseT > 55 || nearD < 30) { r.phase = 'strike'; r.phaseT = t; }
          } else {
            charge(this._pickTarget(r, r.priority));
          }
        }
      }
      return;
    }

    if (r.type === T_HA) {
      r.engageR = 4;
      const skirmish = () => {
        let cavThreat = false;
        this._enemyRegs(r, (o) => { if ((o.type === T_CAV) && Math.hypot(o.cx - r.cx, o.cz - r.cz) < 55) cavThreat = true; });
        if (!near) { hold(r.ax, r.az); return; }
        const dx = r.cx - near.cx, dz = r.cz - near.cz, d = Math.hypot(dx, dz) || 1;
        if (nearD < 65 || cavThreat) {
          r.goalX = r.cx + (dx / d) * 45; r.goalZ = r.cz + (dz / d) * 45; r.moveSpeed = r.run * 0.85;
        } else if (nearD > r.range * 0.85) {
          r.goalX = near.cx; r.goalZ = near.cz; r.moveSpeed = r.walk * 1.3;
        } else { hold(r.ax, r.az); }
        const half = this.terrain.half - 30;
        r.goalX = clamp(r.goalX, -half, half); r.goalZ = clamp(r.goalZ, -half, half);
      };
      if (r.mode === 'close') {
        if (nearD > 50) go(near, r.walk * 1.4); else hold(r.ax, r.az);
        r.engageR = 8;
      } else if (r.mode === 'flank' && r.phase !== 'skirm') {
        if (r.phase === 'start') { r.phase = 'ride'; r.phaseT = t; }
        const half = this.terrain.half - 40;
        const fx = clamp(r.wing > 0 ? enemy.maxX + 70 : enemy.minX - 70, -half, half);
        const fz = clamp(enemy.cz, -half, half);
        r.goalX = fx; r.goalZ = fz; r.moveSpeed = r.run * 0.6; r.faceX = null;
        if (Math.hypot(r.cx - fx, r.cz - fz) < 40 || t - r.phaseT > 50) r.phase = 'skirm';
      } else skirmish();
    }
  }

  _checkEnd() {
    if (this.ended) return;
    const broken = this.sides.map((s) => {
      const troopRegs = this.regs.filter((r) => r.side === s.index && r.kind !== 'engine');
      const allRout = troopRegs.every((r) => r.routing || r.alive === 0);
      return allRout || s.fighting < s.start * 0.2;
    });
    let winner = null;
    if (broken[0] && broken[1]) winner = -1;
    else if (broken[0]) winner = 1;
    else if (broken[1]) winner = 0;
    else if (this.t >= TIME_LIMIT) {
      const f0 = this.sides[0].fighting / this.sides[0].start, f1 = this.sides[1].fighting / this.sides[1].start;
      winner = Math.abs(f0 - f1) < 0.05 ? -1 : f0 > f1 ? 0 : 1;
    }
    if (winner === null) return;
    this.ended = true; this.endT = this.t;
    for (const s of this.sides) {
      s.broken = winner !== s.index;
      if (winner !== s.index) for (const r of this.regs) if (r.side === s.index && r.kind !== 'engine') this._rout(r);
    }
    this.result = { winner, time: this.t, reason: this.t >= TIME_LIMIT ? 'time' : 'broken', stats: this.stats() };
  }

  // ------------------------------------------------------------------ movement
  _moveAnchors() {
    const T = this.terrain;
    const tmp = { x: 0, z: 0 };
    for (const r of this.regs) {
      if (r.kind === 'engine' || r.routing || r.alive === 0) continue;
      let gx = r.goalX, gz = r.goalZ;
      const routed = T.route(r.ax, r.az, gx, gz, tmp);
      if (routed) { gx = tmp.x; gz = tmp.z; }
      // narrow into a column while squeezing through a ford or gap
      const nearBarrier = T.kind !== 'plain' && T.kind !== 'hills' && Math.abs(r.az - T.barrierZ(r.ax)) < 45;
      if (routed && nearBarrier) {
        let pw = 12;
        for (const p of T.passages) if (Math.abs(p.x - r.ax) < 80) pw = Math.max(pw, p.half * 1.4);
        r.colsEff = Math.max(3, Math.min(r.cols, Math.floor(pw / r.sx)));
      } else r.colsEff = r.cols;
      const dx = gx - r.ax, dz = gz - r.az, d = Math.hypot(dx, dz);
      let moving = false;
      if (d > 0.6) {
        let step = Math.min(d, r.moveSpeed * DT * T.speedAt(r.ax, r.az, dx / d, dz / d));
        const lag = Math.hypot(r.ax - r.cx, r.az - r.cz) - Math.ceil(r.alive / r.colsEff) * r.sz * 0.5;
        if (lag > 14) step *= 0.3;
        r.ax += (dx / d) * step; r.az += (dz / d) * step;
        moving = step > 0.01;
      }
      let want;
      if (routed && nearBarrier) want = Math.atan2(dx, dz);
      else if (r.faceX !== null && (!moving || d < 60)) want = Math.atan2(r.faceX - r.ax, r.faceZ - r.az);
      else if (moving) want = Math.atan2(dx, dz);
      else want = r.heading;
      const turn = (r.mounted ? 0.7 : 0.4) * DT;
      r.heading += clamp(angDiff(r.heading, want), -turn, turn);
      r.cosH = Math.cos(r.heading); r.sinH = Math.sin(r.heading);
    }
  }

  _updateUnits() {
    const N = this.N, st = this.st, X = this.x, Z = this.z, VX = this.vx, VZ = this.vz;
    const regs = this.regs, T = this.terrain, rng = this.rng, tick = this.tick;
    const slotP = [0, 0];
    const tmp = { x: 0, z: 0 };
    for (let i = 0; i < N; i++) {
      const s = st[i];
      if (s === S_DEAD || s === S_FLED) continue;
      const r = regs[this.rg[i]];
      if (r.kind === 'engine') { this._engine(i, r); continue; }
      const side = this.sides[r.side];
      let dvx = 0, dvz = 0, face = null;

      if (s === S_ROUT) {
        const ez = -side.dir * T.half;
        let gx = X[i] + (X[i] > 0 ? 0.3 : -0.3), gz = ez;
        if (T.route(X[i], Z[i], gx, gz, tmp)) { gx = tmp.x; gz = tmp.z; }
        const dx = gx - X[i], dz = gz - Z[i], d = Math.hypot(dx, dz) || 1;
        const sp = r.run * 0.92;
        dvx = (dx / d) * sp; dvz = (dz / d) * sp;
        if (Math.abs(Z[i]) > T.half - 14 || Math.abs(X[i]) > T.half - 12) { st[i] = S_FLED; side.fled++; continue; }
        this._steer(i, r, dvx, dvz, null);
        continue;
      }

      this.cd[i] -= DT;
      // (re)target: staggered, or immediately if the current target is gone
      let tgt = this.tg[i];
      const tgtGone = tgt >= 0 && !present(st[tgt]);
      if (((i + tick) & 3) === 0 || tgtGone) {
        tgt = -1;
        if (r.engageR > 0) {
          const e = this._nearest(1 - r.side, X[i], Z[i], r.engageR + r.radius);
          if (e >= 0) {
            this._slotPos(r, this.slot[i], slotP);
            const ld = Math.hypot(X[i] - slotP[0], Z[i] - slotP[1]);
            if (ld < r.leash + r.engageR) tgt = e;
          }
        }
        this.tg[i] = tgt;
        st[i] = tgt >= 0 ? S_FIGHT : S_FORM;
      }

      if (st[i] === S_FIGHT && tgt >= 0) {
        const dx = X[tgt] - X[i], dz = Z[tgt] - Z[i], d = Math.hypot(dx, dz) || 1e-3;
        const reach = r.reach + r.radius + this.radius[tgt];
        face = Math.atan2(dx, dz);
        if (d > reach - 0.1) {
          const sp = r.mounted ? r.run * 0.85 : r.run * 0.8;
          dvx = (dx / d) * sp; dvz = (dz / d) * sp;
        }
        if (d <= reach + 0.25 && this.cd[i] <= 0) {
          this._melee(i, tgt, r);
          this.cd[i] = r.interval * (0.8 + 0.4 * rng());
        }
      } else {
        this._slotPos(r, this.slot[i], slotP);
        let gx = slotP[0], gz = slotP[1];
        if (T.route(X[i], Z[i], gx, gz, tmp)) { gx = tmp.x; gz = tmp.z; }
        const dx = gx - X[i], dz = gz - Z[i], d = Math.hypot(dx, dz);
        if (d > 0.25) {
          const sp = Math.min(r.moveSpeed + d * 0.7, r.run);
          dvx = (dx / d) * sp; dvz = (dz / d) * sp;
        }
        if (d < 3) face = r.heading;
        // missiles
        if (r.range > 0 && r.fireReg >= 0 && this.cd[i] <= 0) {
          const sp2 = VX[i] * VX[i] + VZ[i] * VZ[i];
          if (r.mounted || sp2 < 0.8) this._shoot(i, r);
        }
      }
      this._steer(i, r, dvx, dvz, face);
    }
  }

  _steer(i, r, dvx, dvz, face) {
    const acc = Math.min(1, (r.mounted ? 2.2 : 5) * DT);
    this.vx[i] += (dvx - this.vx[i]) * acc;
    this.vz[i] += (dvz - this.vz[i]) * acc;
    const sp = Math.hypot(this.vx[i], this.vz[i]);
    let want = face;
    if (sp > 1.2 && (face === null || sp > r.walk * 1.2)) want = Math.atan2(this.vx[i], this.vz[i]);
    if (want !== null) {
      const turn = (r.mounted ? 3 : 5) * DT;
      this.hd[i] += clamp(angDiff(this.hd[i], want), -turn, turn);
    }
    // charge build-up
    if (sp > r.run * 0.7) this.chg[i] = Math.min(4, this.chg[i] + DT); else this.chg[i] = Math.max(0, this.chg[i] - DT * 2);
  }

  _separateAndMove() {
    const N = this.N, st = this.st, X = this.x, Z = this.z, R = this.radius, sd = this.sd;
    const G = this.G, half = this.gHalf, T = this.terrain, regs = this.regs;
    const SX = this.sepX, SZ = this.sepZ;
    for (let i = 0; i < N; i++) {
      SX[i] = 0; SZ[i] = 0;
      const s = st[i];
      if (!present(s)) continue;
      const ri = R[i];
      const r = regs[this.rg[i]];
      if (r.kind === 'engine') continue;
      const xi = X[i], zi = Z[i];
      const ccx = ((xi + half) / CELL) | 0, ccz = ((zi + half) / CELL) | 0;
      let ax = 0, az = 0;
      for (let side = 0; side < 2; side++) {
        const friend = side === sd[i];
        if (friend && (r.pass || s === S_ROUT)) continue;
        const start = this.gStart[side], items = this.gItems[side];
        const k = friend ? 0.45 : 0.6;
        for (let cz = ccz - 1; cz <= ccz + 1; cz++) {
          if (cz < 0 || cz >= G) continue;
          for (let cx = ccx - 1; cx <= ccx + 1; cx++) {
            if (cx < 0 || cx >= G) continue;
            const c = cx + cz * G;
            for (let q = start[c], e = start[c + 1]; q < e; q++) {
              const j = items[q];
              if (j === i) continue;
              const dx = xi - X[j], dz = zi - Z[j];
              const m = ri + R[j];
              const d2 = dx * dx + dz * dz;
              if (d2 >= m * m) continue;
              if (d2 < 1e-6) { ax += ((i * 7) % 3 - 1) * 0.05; az += ((i * 13) % 3 - 1) * 0.05; continue; }
              const d = Math.sqrt(d2);
              const push = ((m - d) / d) * k;
              ax += dx * push; az += dz * push;
            }
          }
        }
      }
      const lim = 0.6;
      SX[i] = clamp(ax, -lim, lim); SZ[i] = clamp(az, -lim, lim);
    }
    for (let i = 0; i < N; i++) {
      if (!present(st[i])) continue;
      const r = regs[this.rg[i]];
      if (r.kind === 'engine') continue;
      let vx = this.vx[i], vz = this.vz[i];
      const sp = Math.hypot(vx, vz);
      let m = 1;
      if (sp > 0.05) m = T.speedAt(X[i], Z[i], vx / sp, vz / sp);
      const nx = X[i] + vx * m * DT + SX[i], nz = Z[i] + vz * m * DT + SZ[i];
      const rr = R[i];
      if (!T.blocked(nx, nz, rr)) { X[i] = nx; Z[i] = nz; }
      else if (!T.blocked(nx, Z[i], rr)) { X[i] = nx; this.vz[i] *= 0.5; }
      else if (!T.blocked(X[i], nz, rr)) { Z[i] = nz; this.vx[i] *= 0.5; }
      else { this.vx[i] *= 0.3; this.vz[i] *= 0.3; }
    }
  }

  // ------------------------------------------------------------------ combat
  _facingDot(j, fromX, fromZ) {
    const dx = fromX - this.x[j], dz = fromZ - this.z[j], d = Math.hypot(dx, dz) || 1;
    return (Math.sin(this.hd[j]) * dx + Math.cos(this.hd[j]) * dz) / d;
  }

  _melee(i, j, r) {
    const rng = this.rng;
    const tr = this.regs[this.rg[j]];
    this.sides[r.side].lastMeleeT = this.t;
    if (rng() < 0.12) return; // whiff
    let dmg = r.dmgMelee * r.attackMul;
    if (tr.mounted) dmg *= r.vsMounted;
    // charge impact
    const charging = this.chg[i] > 1.2;
    if (charging) {
      dmg *= r.mounted ? r.chargeMul : 1 + (r.chargeMul - 1) * 0.5;
      this.chg[i] = 0;
      if (r.mounted) {
        // knock the target back a little
        const dx = this.x[j] - this.x[i], dz = this.z[j] - this.z[i], d = Math.hypot(dx, dz) || 1;
        if (tr.kind !== 'engine') { this.vx[j] += (dx / d) * 4; this.vz[j] += (dz / d) * 4; }
        // braced spears bite back
        if (tr.spear && this.st[j] !== S_ROUT) this._damage(i, 22 * tr.defMul, this.regs[this.rg[i]]);
      }
    }
    const hi = this.terrain.heightAt(this.x[i], this.z[i]), hj = this.terrain.heightAt(this.x[j], this.z[j]);
    dmg *= 1 + clamp((hi - hj) * 0.025, -0.15, 0.25);
    if (this.st[j] === S_ROUT) dmg *= 1.6;
    else {
      const dot = this._facingDot(j, this.x[i], this.z[i]);
      if (dot < -0.45) { dmg *= 1.6; tr.rearHits++; }
      else if (dot < 0.25) { dmg *= 1.2; tr.rearHits += 0.3; }
      if (dot > -0.2) {
        const block = Math.min(0.85, tr.blockMelee * tr.defMul * (dot > 0.5 ? 1 : 0.6));
        if (rng() < block) dmg *= 0.2;
      }
    }
    dmg *= 1 - tr.armorDef * (1 - r.pierce) * (tr.defMul > 1 ? Math.min(1.2, tr.defMul * 0.8) : 1);
    this._damage(j, dmg, tr);
  }

  _missileHit(j, dmg, pierce, fromX, fromZ) {
    const tr = this.regs[this.rg[j]];
    if (this.st[j] !== S_ROUT) {
      const dot = this._facingDot(j, fromX, fromZ);
      if (dot > -0.2) {
        const block = Math.min(0.9, tr.blockMissile * tr.defMul * (dot > 0.4 ? 1 : 0.6));
        if (this.rng() < block) dmg *= 0.08;
      }
    }
    dmg *= 1 - tr.armorDef * (1 - pierce);
    tr.missileHits++;
    this._damage(j, dmg, tr);
  }

  _damage(j, dmg, tr) {
    if (!present(this.st[j])) return;
    this.hp[j] -= dmg;
    if (this.hp[j] <= 0) {
      this.st[j] = S_DEAD; this.deadT[j] = this.t; this.tg[j] = -1;
      tr.recentLoss++;
      this.sides[tr.side].dead++;
      if (tr.kind === 'engine') this.pushEvent('engineDown', this.x[j], this.z[j], tr.side);
    }
  }

  _shoot(i, r) {
    const tr = this.regs[r.fireReg];
    const rng = this.rng, st = this.st;
    let j = -1;
    for (let k = 0; k < 4; k++) {
      const c = tr.units[(rng() * tr.units.length) | 0];
      if (present(st[c])) { j = c; break; }
    }
    if (j < 0) { this.cd[i] = 0.4; return; }
    const T = this.terrain;
    const hs = T.heightAt(this.x[i], this.z[i]), ht = T.heightAt(this.x[j], this.z[j]);
    const dx = this.x[j] - this.x[i], dz = this.z[j] - this.z[i], d = Math.hypot(dx, dz);
    const range = r.range * (1 + clamp((hs - ht) / 70, -0.15, 0.3));
    if (d > range || d < 6) { this.cd[i] = 0.3 + rng() * 0.4; return; }
    const speed = 55;
    const dur = d / speed + 0.6;
    const sigma = (0.7 + d * 0.028) * (1.5 - r.accuracy) * (r.mounted ? 1.25 : 1);
    const ex = this.x[j] + this.vx[j] * dur * 0.5 + rng.gauss() * sigma;
    const ez = this.z[j] + this.vz[j] * dur * 0.5 + rng.gauss() * sigma;
    this._spawnProj(P_ARROW, r.side, this.x[i], hs + 1.6, this.z[i], ex, ez, dur, d * r.arc * 0.55,
      r.missileDmg, r.missilePierce, 0, 1);
    this.fireT[i] = this.t;
    this.hd[i] = Math.atan2(dx, dz);
    this.cd[i] = (r.missileInterval / r.fireRate) * (0.8 + 0.4 * rng());
  }

  _engine(i, r) {
    if (this.ended) return;
    this.cd[i] -= DT;
    if (this.cd[i] > 0) return;
    const rng = this.rng, T = this.terrain;
    let tx, tz, have = false;
    if (r.wallTarget >= 0 && T.walls[r.wallTarget]?.alive) {
      const W = T.walls[r.wallTarget];
      tx = W.x0 + (W.x1 - W.x0) * (0.2 + 0.6 * rng()); tz = (W.z0 + W.z1) / 2; have = true;
    } else if (r.fireReg >= 0) {
      const tr = this.regs[r.fireReg];
      if (r.proj === P_BOLT) {
        for (let k = 0; k < 4 && !have; k++) {
          const c = tr.units[(rng() * tr.units.length) | 0];
          if (present(this.st[c])) { tx = this.x[c]; tz = this.z[c]; have = true; }
        }
      } else if (tr.alive > 0) { tx = tr.cx; tz = tr.cz; have = true; }
    }
    // fall back to the nearest enemy in range
    if (!have || Math.hypot(tx - this.x[i], tz - this.z[i]) > r.range) {
      const e = this._nearestFar(1 - r.side, this.x[i], this.z[i], r.range);
      if (e < 0) { this.cd[i] = 1; return; }
      tx = this.x[e]; tz = this.z[e]; have = true;
    }
    const dx = tx - this.x[i], dz = tz - this.z[i], d = Math.hypot(dx, dz);
    if (d < r.minRange) { this.cd[i] = 1; return; }
    const hs = T.heightAt(this.x[i], this.z[i]);
    const sigma = r.proj === P_BOLT ? 0.6 + d * 0.008 : 2.5 + d * 0.03;
    let ex = tx + rng.gauss() * sigma, ez = tz + rng.gauss() * sigma;
    const dur = d / r.projSpeed + (r.proj === P_BOLT ? 0.1 : 1.6);
    if (r.proj === P_BOLT) {
      // bolts fly on past the aim point
      ex += (dx / d) * 18; ez += (dz / d) * 18;
      this._spawnProj(P_BOLT, r.side, this.x[i], hs + 1.6, this.z[i], ex, ez, dur * (d + 18) / d, d * 0.02,
        r.dmg, 0.8, 0, r.pierceCount);
    } else {
      this._spawnProj(P_STONE, r.side, this.x[i], hs + (r.type === T_TREB ? 12 : 4), this.z[i], ex, ez, dur,
        d * (r.type === T_TREB ? 0.45 : 0.32), r.dmg, 0.8, r.splash, 1);
    }
    this.hd[i] = Math.atan2(dx, dz);
    this.fireT[i] = this.t;
    this.cd[i] = r.reload * (r.reloadMul || 1) * (0.9 + 0.2 * rng());
  }

  /** nearest present enemy unit in range, coarse scan of regiment centroids then units */
  _nearestFar(s, x, z, range) {
    let best = null, bd = range;
    for (const o of this.regs) {
      if (o.side !== s || o.alive === 0) continue;
      const d = Math.hypot(o.cx - x, o.cz - z);
      if (d < bd) { bd = d; best = o; }
    }
    if (!best) return -1;
    for (const u of best.units) if (present(this.st[u])) return u;
    return -1;
  }

  _spawnProj(kind, side, sx, sy, sz, ex, ez, dur, apex, dmg, pierce, splash, n) {
    if (this.pCount >= MAX_PROJ) return;
    const k = this.pCount++;
    this.pk[k] = kind; this.ps[k] = side;
    this.psx[k] = sx; this.psy[k] = sy; this.psz[k] = sz;
    this.pex[k] = ex; this.pez[k] = ez; this.pey[k] = this.terrain.heightAt(ex, ez);
    this.pt0[k] = this.t; this.pdur[k] = dur; this.papex[k] = apex;
    this.pdmg[k] = dmg; this.ppierce[k] = pierce; this.psplash[k] = splash; this.pn[k] = n;
  }

  _removeProj(k) {
    const last = --this.pCount;
    if (k === last) return;
    for (const a of [this.pk, this.ps, this.psx, this.psy, this.psz, this.pex, this.pey, this.pez, this.pt0, this.pdur, this.papex, this.pdmg, this.ppierce, this.psplash, this.pn]) a[k] = a[last];
  }

  _wallBlocks(sx, sz, ex, ez) {
    const T = this.terrain;
    if (T.kind !== 'castle') return null;
    const wz = T.wallZ;
    if ((sz - wz) * (ez - wz) >= 0) return null; // same side
    if (Math.abs(ez - wz) > 16) return null; // lands well past the wall: arcs over
    const tcross = (wz - sz) / (ez - sz);
    const cx = sx + (ex - sx) * tcross;
    for (const W of T.walls) if (W.alive && cx >= W.x0 && cx <= W.x1) return W;
    return null;
  }

  _updateProjectiles() {
    const t = this.t, T = this.terrain;
    for (let k = this.pCount - 1; k >= 0; k--) {
      if (t < this.pt0[k] + this.pdur[k]) continue;
      const kind = this.pk[k], side = this.ps[k], foe = 1 - side;
      const ex = this.pex[k], ez = this.pez[k], sx = this.psx[k], sz = this.psz[k];
      const dmg = this.pdmg[k], pierce = this.ppierce[k];
      if (kind === P_ARROW) {
        const W = this._wallBlocks(sx, sz, ex, ez);
        if (!(W && this.rng() < 0.7)) {
          const j = this._nearest(foe, ex, ez, 1.6);
          if (j >= 0) {
            const dd = Math.hypot(this.x[j] - ex, this.z[j] - ez);
            if (dd < 0.55 + this.radius[j]) this._missileHit(j, dmg, pierce, sx, sz);
          }
        }
      } else if (kind === P_STONE) {
        const splash = this.psplash[k];
        this._forRadius(foe, ex, ez, splash, (j, d) => {
          this._missileHit(j, dmg * (1 - 0.6 * Math.min(1, d / splash)), pierce, ex, ez + 0.01);
        });
        this._hitWalls(ex, ez, dmg * 6, side);
        this.pushEvent('stone', ex, ez, side);
      } else if (kind === P_BOLT) {
        const dx = ex - sx, dz = ez - sz, d = Math.hypot(dx, dz) || 1;
        const ux = dx / d, uz = dz / d;
        let left = this.pn[k];
        const hit = new Set();
        for (let s = 36; s >= 0 && left > 0; s -= 1.5) {
          const qx = ex - ux * s, qz = ez - uz * s;
          const j = this._nearest(foe, qx, qz, 1.4);
          if (j >= 0 && !hit.has(j)) { hit.add(j); this._missileHit(j, dmg * (1 - 0.1 * hit.size), pierce, sx, sz); left--; }
        }
        this._hitWalls(ex, ez, dmg * 1.2, side);
        this.pushEvent('bolt', ex, ez, side);
      }
      void T;
      this._removeProj(k);
    }
  }

  _hitWalls(x, z, dmg, side) {
    const T = this.terrain;
    if (T.kind !== 'castle' || side === this.defender) return;
    if (Math.abs(z - T.wallZ) > 7) return;
    for (const W of T.walls) {
      if (!W.alive || x < W.x0 - 3 || x > W.x1 + 3) continue;
      W.hp -= dmg;
      if (W.hp <= 0) {
        W.alive = false; W.hp = 0;
        T.refreshPassages();
        this.pushEvent('breach', (W.x0 + W.x1) / 2, T.wallZ, W.id);
      }
    }
  }

  // ------------------------------------------------------------------ stats
  stats() {
    return this.sides.map((s) => {
      const byType = {};
      let routing = 0, moraleSum = 0, moraleN = 0, engines = 0, fighting = 0;
      for (const r of this.regs) {
        if (r.side !== s.index) continue;
        let a = 0;
        for (const i of r.units) { const v = this.st[i]; if (v === S_FORM || v === S_FIGHT) a++; else if (v === S_ROUT) routing++; }
        if (r.kind !== 'engine') fighting += a;
        byType[r.typeName] = (byType[r.typeName] || 0) + a;
        if (r.kind === 'engine') engines += a;
        else if (!r.routing && r.alive > 0) { moraleSum += Math.max(0, r.morale) / Math.max(1, r.maxMorale); moraleN++; }
      }
      return {
        name: s.army.name, style: s.style.label, styleId: s.styleId, start: s.start, fighting,
        dead: s.dead, fled: s.fled, routing, byType, engines, morale: moraleN ? moraleSum / moraleN : 0,
      };
    });
  }
}
