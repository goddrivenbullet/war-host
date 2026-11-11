// Battlefield terrain shared by the simulation and the renderer.
// Pure math, no rendering imports, so it runs in Node tests too.
import { makeRng } from './rng.js';

function makeNoise(seed) {
  const rng = makeRng(seed);
  const P = 256;
  const vals = new Float32Array(P * P);
  for (let i = 0; i < vals.length; i++) vals[i] = rng() * 2 - 1;
  const v = (ix, iz) => vals[((ix & (P - 1)) + (iz & (P - 1)) * P)];
  const smooth = (t) => t * t * (3 - 2 * t);
  const noise = (x, z) => {
    const ix = Math.floor(x), iz = Math.floor(z);
    const fx = smooth(x - ix), fz = smooth(z - iz);
    const a = v(ix, iz), b = v(ix + 1, iz), c = v(ix, iz + 1), d = v(ix + 1, iz + 1);
    return (a + (b - a) * fx) + ((c + (d - c) * fx) - (a + (b - a) * fx)) * fz;
  };
  return (x, z, oct = 4) => {
    let s = 0, amp = 1, f = 1, norm = 0;
    for (let o = 0; o < oct; o++) {
      s += noise(x * f, z * f) * amp;
      norm += amp; amp *= 0.5; f *= 2.03;
    }
    return s / norm;
  };
}

export const WATER_LEVEL = -1.0;
export const RIM_HEIGHT = 16;

/**
 * @param {object} map  map definition from data/maps.json (plus id)
 * @param {object} opts { seed, defender } defender = side index holding the castle (0 or 1)
 */
export function createTerrain(map, opts = {}) {
  const seed = opts.seed ?? 1;
  const defender = opts.defender ?? 1;
  const size = map.size;
  const half = size / 2;
  const res = 3; // metres per height sample
  const n = Math.ceil(size / res) + 1;
  const heights = new Float32Array(n * n);
  const fbm = makeNoise(seed * 7 + 13);
  const kind = map.kind;

  // ---- river geometry
  const riverHalf = (map.riverWidth || 30) / 2;
  const fords = (map.fords || []).map((x) => ({ x, half: (map.fordWidth || 36) / 2 }));
  const riverZ = (x) => 14 * Math.sin(x / 110) + 7 * Math.sin(x / 47 + 1.3);
  const inFord = (x) => {
    for (const f of fords) if (Math.abs(x - f.x) < f.half) return true;
    return false;
  };

  // ---- castle geometry: the wall lies across the whole field
  const wallSign = defender === 0 ? -1 : 1;
  const wallZ = kind === 'castle' ? wallSign * (map.wallOffset || 85) : 0;
  const walls = [];
  if (kind === 'castle') {
    const gaps = (map.gaps || []).map((x) => ({ x, half: (map.gapWidth || 14) / 2 }));
    const gateHalf = (map.gateWidth || 22) / 2;
    const segLen = 36, thick = 5, height = 9;
    // Build list of x-intervals that are wall (skip posterns).
    const cuts = [];
    for (const g of gaps) cuts.push([g.x - g.half, g.x + g.half]);
    cuts.sort((a, b) => a[0] - b[0]);
    let x = -half;
    const spans = [];
    for (const c of cuts) { if (c[0] > x) spans.push([x, c[0]]); x = c[1]; }
    if (x < half) spans.push([x, half]);
    for (const [a, b] of spans) {
      let s = a;
      while (s < b - 0.5) {
        let e = Math.min(b, s + segLen);
        // The gate is its own segment in the middle.
        if (s < -gateHalf && e > -gateHalf) e = -gateHalf;
        else if (s >= -gateHalf - 0.01 && s < gateHalf) e = Math.min(b, gateHalf);
        const gate = s >= -gateHalf - 0.01 && e <= gateHalf + 0.01;
        const maxHp = gate ? 2600 : 5200;
        walls.push({
          id: walls.length, x0: s, x1: e, z0: wallZ - thick / 2, z1: wallZ + thick / 2,
          height: gate ? 7 : height, hp: maxHp, maxHp, gate, alive: true,
        });
        s = e;
      }
    }
  }

  // ---- height function
  const baseHeight = (x, z) => {
    const r = map.relief || 2;
    let h = fbm(x / 140 + 11, z / 140 - 7, 4) * r;
    h += fbm(x / 35, z / 35, 2) * (map.detail || 1) * 0.35;
    if (kind === 'hills') {
      const g = (map.startGap || 320) / 2;
      const ridge = (zc) => Math.exp(-Math.pow((z - zc) / 85, 2));
      h += 20 * ridge(-g - 25) * (1 + 0.25 * Math.sin(x / 90));
      h += 20 * ridge(g + 25) * (1 + 0.25 * Math.cos(x / 80));
      h += 12 * Math.exp(-((x - 260) ** 2 + (z + 10) ** 2) / (2 * 70 * 70));
      h += 10 * Math.exp(-((x + 280) ** 2 + (z - 20) ** 2) / (2 * 65 * 65));
      h -= 4 * Math.exp(-(z * z) / (2 * 60 * 60));
    }
    if (kind === 'river') {
      h = Math.max(h, -0.2) + 0.6;
      const d = Math.abs(z - riverZ(x));
      const bank = riverHalf + 14;
      if (d < bank) {
        const ford = inFord(x);
        const depth = ford ? 1.45 : 4.8;
        const t = d < riverHalf ? 1 : 1 - (d - riverHalf) / 14;
        const s = t * t * (3 - 2 * t);
        h = h * (1 - s) + (-depth + 0.4) * s;
        if (d < riverHalf) h = -depth + fbm(x / 9, z / 9, 1) * 0.25;
      }
    }
    if (kind === 'castle') {
      // Defender ground rises gently behind the wall.
      const behind = (z - wallZ) * wallSign;
      if (behind > -10) h += Math.min(6, (behind + 10) * 0.06);
      // A dirt road to the gate.
      h -= 0.3 * Math.exp(-(x * x) / 60);
    }
    // Soft rim so the edge of the world reads as hills.
    const edge = Math.max(Math.abs(x), Math.abs(z)) - (half - 90);
    if (edge > 0) {
      const t = Math.min(1, edge / 90), s = t * t * (3 - 2 * t);
      h = h * (1 - s) + (RIM_HEIGHT + fbm(x / 60, z / 60, 2) * 5) * s;
    }
    return h;
  };

  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      heights[i + j * n] = baseHeight(-half + i * res, -half + j * res);
    }
  }

  const heightAt = (x, z) => {
    let fx = (x + half) / res, fz = (z + half) / res;
    if (fx < 0) fx = 0; else if (fx > n - 1.001) fx = n - 1.001;
    if (fz < 0) fz = 0; else if (fz > n - 1.001) fz = n - 1.001;
    const ix = fx | 0, iz = fz | 0;
    const tx = fx - ix, tz = fz - iz;
    const k = ix + iz * n;
    const a = heights[k], b = heights[k + 1], c = heights[k + n], d = heights[k + n + 1];
    return a + (b - a) * tx + ((c + (d - c) * tx) - (a + (b - a) * tx)) * tz;
  };

  const isDeep = (x, z) => kind === 'river' && Math.abs(z - riverZ(x)) < riverHalf - 1 && !inFord(x);
  const inShallows = (x, z) => kind === 'river' && Math.abs(z - riverZ(x)) < riverHalf + 1 && inFord(x);

  /** true if a circle of radius r at (x,z) is not allowed */
  const blocked = (x, z, r = 0.5) => {
    if (x < -half + 8 || x > half - 8 || z < -half + 8 || z > half - 8) return true;
    if (kind === 'river') return isDeep(x, z);
    if (kind === 'castle' && Math.abs(z - wallZ) < 4 + r) {
      for (let w = 0; w < walls.length; w++) {
        const W = walls[w];
        if (!W.alive) continue;
        if (x > W.x0 - r && x < W.x1 + r && z > W.z0 - r && z < W.z1 + r) return true;
      }
    }
    return false;
  };

  /** movement multiplier for travelling in direction (dx,dz) (unit vector) */
  const speedAt = (x, z, dx, dz) => {
    let m = 1;
    if (inShallows(x, z)) m *= 0.55;
    const e = 2;
    const slope = (heightAt(x + dx * e, z + dz * e) - heightAt(x, z)) / e;
    if (slope > 0) m *= Math.max(0.5, 1 - slope * 2.2);
    else m *= Math.min(1.12, 1 - slope * 0.6);
    return m;
  };

  // ---- barrier side / passage helpers for navigation
  const hasBarrier = kind === 'river' || kind === 'castle';
  const sideOf = (x, z) => {
    if (kind === 'river') return z < riverZ(x) ? -1 : 1;
    if (kind === 'castle') return z < wallZ ? -1 : 1;
    return 0;
  };
  const barrierZ = (x) => (kind === 'river' ? riverZ(x) : wallZ);
  let passages = [];
  const refreshPassages = () => {
    passages = [];
    if (kind === 'river') for (const f of fords) passages.push({ x: f.x, half: f.half - 3 });
    if (kind === 'castle') {
      for (const x of map.gaps || []) passages.push({ x, half: (map.gapWidth || 14) / 2 - 1.5 });
      for (const W of walls) if (!W.alive) passages.push({ x: (W.x0 + W.x1) / 2, half: (W.x1 - W.x0) / 2 - 1.5, breach: true });
    }
  };
  refreshPassages();

  /**
   * If (x,z) -> (tx,tz) crosses the barrier, return an intermediate waypoint
   * through the best passage; otherwise return null.
   */
  const route = (x, z, tx, tz, out) => {
    if (!hasBarrier) return false;
    const s0 = sideOf(x, z), s1 = sideOf(tx, tz);
    if (s0 === s1) return false;
    let best = null, bestD = Infinity;
    for (const p of passages) {
      const pz = barrierZ(p.x);
      const d = Math.hypot(x - p.x, z - pz) + Math.hypot(tx - p.x, tz - pz);
      if (d < bestD) { bestD = d; best = p; }
    }
    if (!best) { out.x = x; out.z = z; return true; }
    const bz = barrierZ(best.x);
    const lim = Math.max(1, best.half * 0.75);
    const inCorridor = Math.abs(x - best.x) < lim;
    const near = Math.abs(z - bz) < 22;
    if (inCorridor && near) {
      // go straight through to the far side
      const px = best.x + Math.max(-lim, Math.min(lim, x - best.x));
      out.x = px; out.z = bz + s1 * 16;
    } else {
      const px = best.x + Math.max(-lim, Math.min(lim, tx - best.x)) * 0.5;
      out.x = px; out.z = bz + s0 * 14;
    }
    return true;
  };

  return {
    map, kind, size, half, res, n, heights, heightAt, blocked, speedAt, isDeep, inShallows,
    riverZ, riverHalf, fords, walls, wallZ, defender, route, refreshPassages,
    get passages() { return passages; }, sideOf, barrierZ,
  };
}
