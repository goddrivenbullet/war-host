// Low-poly procedural models. Every model is one merged BufferGeometry with
// vertex colours, so a whole army type is a single instanced draw call.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

const tmpColor = new THREE.Color();

export function part(geo, color, pos = [0, 0, 0], rot = [0, 0, 0], scale = [1, 1, 1]) {
  const g = geo.index ? geo.toNonIndexed() : geo.clone();
  const m = new THREE.Matrix4().compose(
    new THREE.Vector3(...pos),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(...rot)),
    new THREE.Vector3(...scale),
  );
  g.applyMatrix4(m);
  tmpColor.set(color);
  const n = g.attributes.position.count;
  const c = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { c[i * 3] = tmpColor.r; c[i * 3 + 1] = tmpColor.g; c[i * 3 + 2] = tmpColor.b; }
  g.setAttribute('color', new THREE.BufferAttribute(c, 3));
  for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'color'].includes(k)) g.deleteAttribute(k);
  return g;
}

export const merge = (parts) => mergeGeometries(parts, false);

const B = (w, h, d) => new THREE.BoxGeometry(w, h, d);
const C = (r0, r1, h, s = 6) => new THREE.CylinderGeometry(r0, r1, h, s);

const SKIN = '#d2a27a', DARK = '#3a3128', WOOD = '#6b4a2b', METAL = '#9aa1a8', LEATHER = '#5e4630', HORSE = ['#5b3b24', '#3a2a1e', '#7a5a3a'];

function bodyColor(armor, team) {
  return armor.tint === 'team' ? team : armor.tint;
}

function weaponParts(key, y, team, mounted) {
  const p = [];
  const fx = 0.34;
  switch (key) {
    case 'spear':
      p.push(part(C(0.03, 0.03, 2.8, 4), WOOD, [fx, y + 0.2, 0.25], [0.35, 0, 0]));
      p.push(part(new THREE.ConeGeometry(0.06, 0.25, 4), METAL, [fx, y + 1.53, 0.72], [0.35, 0, 0]));
      break;
    case 'lance':
      p.push(part(C(0.035, 0.05, 3.6, 5), team, [fx, y + 0.1, 1.2], [Math.PI / 2 - 0.12, 0, 0]));
      p.push(part(new THREE.ConeGeometry(0.05, 0.3, 4), METAL, [fx, y + 0.32, 3.1], [Math.PI / 2 - 0.12, 0, 0]));
      break;
    case 'sword': case 'sabre':
      p.push(part(B(0.06, 0.85, 0.04), METAL, [fx, y + 0.15, 0.32], [0.6, 0, 0]));
      p.push(part(B(0.22, 0.04, 0.05), DARK, [fx, y - 0.2, 0.12], [0.6, 0, 0]));
      break;
    case 'axe':
      p.push(part(C(0.03, 0.03, 1.0, 4), WOOD, [fx, y + 0.1, 0.3], [0.6, 0, 0]));
      p.push(part(B(0.05, 0.28, 0.24), METAL, [fx, y + 0.45, 0.62], [0.6, 0, 0]));
      break;
    case 'mace':
      p.push(part(C(0.03, 0.03, 0.9, 4), WOOD, [fx, y + 0.1, 0.3], [0.6, 0, 0]));
      p.push(part(new THREE.IcosahedronGeometry(0.12, 0), METAL, [fx, y + 0.45, 0.55]));
      break;
    case 'shortbow': case 'longbow': case 'composite': {
      const r = key === 'longbow' ? 0.8 : key === 'composite' ? 0.45 : 0.55;
      p.push(part(new THREE.TorusGeometry(r, 0.025, 3, 8, Math.PI), WOOD, [-0.32, y + 0.1, 0.35], [0, Math.PI / 2, Math.PI / 2]));
      p.push(part(B(0.01, r * 2, 0.01), '#ddd6c0', [-0.32, y + 0.1, 0.35]));
      p.push(part(B(0.14, 0.55, 0.14), LEATHER, [0.12, y + 0.05, -0.22], [0.3, 0, 0.2]));
      break;
    }
    case 'crossbow':
      p.push(part(B(0.08, 0.08, 0.75), WOOD, [0.12, y + 0.05, 0.4]));
      p.push(part(B(0.75, 0.04, 0.05), METAL, [0.12, y + 0.05, 0.72]));
      p.push(part(B(0.14, 0.4, 0.14), LEATHER, [-0.15, y - 0.1, -0.22]));
      break;
  }
  void mounted;
  return p;
}

function humanParts({ armor, shield, weapon, team, y0 = 0, mounted = false }) {
  const p = [];
  const body = bodyColor(armor, team);
  const heavy = armor.defense >= 0.4;
  if (!mounted) {
    p.push(part(B(0.17, 0.82, 0.2), DARK, [-0.11, y0 + 0.41, 0]));
    p.push(part(B(0.17, 0.82, 0.2), DARK, [0.11, y0 + 0.41, 0]));
  } else {
    p.push(part(B(0.17, 0.5, 0.45), DARK, [-0.3, y0 + 0.1, 0.1], [0, 0, 0.3]));
    p.push(part(B(0.17, 0.5, 0.45), DARK, [0.3, y0 + 0.1, 0.1], [0, 0, -0.3]));
  }
  const ty = y0 + (mounted ? 0.55 : 1.13);
  p.push(part(B(0.5, 0.64, 0.3), body, [0, ty, 0]));
  // tabard in team colour so armoured troops still read as their side
  p.push(part(B(0.42, 0.5, 0.33), team, [0, ty - 0.08, 0]));
  p.push(part(B(0.13, 0.56, 0.13), body, [-0.32, ty - 0.02, 0.04]));
  p.push(part(B(0.13, 0.56, 0.13), body, [0.32, ty - 0.02, 0.06], [0.4, 0, 0]));
  const hy = ty + 0.47;
  p.push(part(B(0.24, 0.27, 0.25), SKIN, [0, hy, 0]));
  if (heavy) p.push(part(new THREE.ConeGeometry(0.19, 0.3, 6), METAL, [0, hy + 0.2, 0]));
  else p.push(part(B(0.27, 0.1, 0.27), armor.tint === 'team' ? DARK : LEATHER, [0, hy + 0.15, 0]));
  if (shield.size > 0) {
    const s = shield.size;
    p.push(part(B(s * 0.72, s, 0.06), team, [-0.33, ty - 0.1 + (s > 1 ? -0.15 : 0), 0.22]));
    p.push(part(B(s * 0.22, s * 0.22, 0.08), '#d9c27a', [-0.33, ty - 0.1 + (s > 1 ? -0.15 : 0), 0.24]));
  }
  p.push(...weaponParts(weapon, ty, team, mounted));
  return p;
}

function horseParts(team, armor, colorIndex = 0) {
  const p = [];
  const hc = HORSE[colorIndex % HORSE.length];
  p.push(part(B(0.6, 0.62, 1.75), hc, [0, 1.3, 0]));
  p.push(part(B(0.3, 0.75, 0.38), hc, [0, 1.75, 0.85], [0.6, 0, 0]));
  p.push(part(B(0.24, 0.26, 0.6), hc, [0, 2.05, 1.2], [0.3, 0, 0]));
  for (const [x, z] of [[-0.2, 0.65], [0.2, 0.65], [-0.2, -0.65], [0.2, -0.65]]) p.push(part(B(0.14, 1.05, 0.14), hc, [x, 0.52, z]));
  p.push(part(B(0.1, 0.6, 0.12), DARK, [0, 1.2, -0.95], [-0.5, 0, 0]));
  // caparison in team colour
  const cap = armor.defense >= 0.4 ? armor.tint : team;
  p.push(part(B(0.68, 0.42, 1.3), cap, [0, 1.25, -0.05]));
  p.push(part(B(0.7, 0.12, 1.32), team, [0, 1.02, -0.05]));
  return p;
}

/** Returns a geometry for a troop type given the army loadout and team colour. */
export function troopGeometry(type, loadout, data, team) {
  const armor = data.armor.armor[loadout.armor];
  const shield = data.armor.shields[loadout.shield];
  const weapon = loadout.weapon;
  if (type === 'cavalry' || type === 'horseArchers') {
    return merge([...horseParts(team, armor), ...humanParts({ armor, shield, weapon, team, y0: 1.55, mounted: true })]);
  }
  return merge(humanParts({ armor, shield, weapon, team }));
}

// ------------------------------------------------------------------ siege engines
export function trebuchetModel(team) {
  const base = [];
  base.push(part(B(5, 0.4, 0.4), WOOD, [0, 0.4, -2.2]));
  base.push(part(B(5, 0.4, 0.4), WOOD, [0, 0.4, 2.2]));
  base.push(part(B(0.4, 0.4, 4.8), WOOD, [-2.2, 0.4, 0]));
  base.push(part(B(0.4, 0.4, 4.8), WOOD, [2.2, 0.4, 0]));
  for (const x of [-1.1, 1.1]) {
    base.push(part(B(0.35, 7.6, 0.35), WOOD, [x, 4, -1.4], [0.35, 0, 0]));
    base.push(part(B(0.35, 7.6, 0.35), WOOD, [x, 4, 1.4], [-0.35, 0, 0]));
  }
  base.push(part(C(0.2, 0.2, 2.6, 6), DARK, [0, 7.5, 0], [0, 0, Math.PI / 2]));
  base.push(part(B(0.05, 1.2, 0.8), team, [2.6, 6.8, 0]));
  base.push(part(C(0.04, 0.04, 2.8, 4), WOOD, [2.6, 6.4, -0.4]));
  const arm = [];
  arm.push(part(B(0.32, 0.32, 11), WOOD, [0, 0, 2.5]));
  arm.push(part(B(1.6, 1.6, 1.6), '#5c5a55', [0, -1.0, -2.6]));
  arm.push(part(B(0.4, 0.4, 0.4), '#8a8378', [0, -0.3, 8.0]));
  return { base: merge(base), arm: merge(arm), pivotY: 7.5, rest: -0.75, fired: 1.35 };
}

export function catapultModel(team) {
  const base = [];
  base.push(part(B(0.3, 0.4, 4.2), WOOD, [-0.9, 0.9, 0]));
  base.push(part(B(0.3, 0.4, 4.2), WOOD, [0.9, 0.9, 0]));
  base.push(part(B(2.1, 0.3, 0.3), WOOD, [0, 0.9, 1.6]));
  base.push(part(B(2.1, 0.3, 0.3), WOOD, [0, 0.9, -1.6]));
  base.push(part(B(2.1, 0.35, 0.35), WOOD, [0, 2.4, 0.9]));
  base.push(part(B(0.3, 1.6, 0.3), WOOD, [-0.9, 1.7, 0.9]));
  base.push(part(B(0.3, 1.6, 0.3), WOOD, [0.9, 1.7, 0.9]));
  for (const [x, z] of [[-1.15, 1.4], [1.15, 1.4], [-1.15, -1.4], [1.15, -1.4]]) base.push(part(C(0.6, 0.6, 0.2, 8), DARK, [x, 0.6, z], [0, 0, Math.PI / 2]));
  base.push(part(B(0.05, 0.6, 0.9), team, [1.1, 2.3, -1.2]));
  const arm = [];
  arm.push(part(B(0.3, 0.3, 3.2), WOOD, [0, 0, -1.6]));
  arm.push(part(B(0.8, 0.3, 0.8), WOOD, [0, 0.15, -3.1]));
  return { base: merge(base), arm: merge(arm), pivotY: 1.1, pivotZ: 0.2, rest: 0.05, fired: -1.25 };
}

export function ballistaModel(team) {
  const base = [];
  base.push(part(B(0.25, 1.4, 0.25), WOOD, [-0.5, 0.7, 0]));
  base.push(part(B(0.25, 1.4, 0.25), WOOD, [0.5, 0.7, 0]));
  base.push(part(B(1.6, 0.25, 1.6), WOOD, [0, 0.15, 0]));
  base.push(part(B(0.05, 0.5, 0.7), team, [0.7, 1.2, -0.6]));
  const arm = [];
  arm.push(part(B(0.3, 0.25, 3.0), WOOD, [0, 0, 0.3]));
  arm.push(part(B(1.4, 0.2, 0.2), WOOD, [-0.7, 0, 1.4], [0, 0.5, 0]));
  arm.push(part(B(1.4, 0.2, 0.2), WOOD, [0.7, 0, 1.4], [0, -0.5, 0]));
  arm.push(part(B(0.05, 0.05, 2.4), '#cfc6ad', [0, 0.15, 0.6]));
  arm.push(part(new THREE.ConeGeometry(0.08, 0.3, 4), METAL, [0, 0.15, 1.9], [Math.PI / 2, 0, 0]));
  return { base: merge(base), arm: merge(arm), pivotY: 1.5, rest: 0, fired: 0, yawOnly: true };
}

export function bannerGeometry() {
  const pole = merge([part(C(0.06, 0.06, 6.5, 5), WOOD, [0, 3.25, 0]), part(new THREE.ConeGeometry(0.12, 0.35, 4), '#d9c27a', [0, 6.6, 0])]);
  const flag = new THREE.PlaneGeometry(2.2, 1.4, 4, 1);
  flag.translate(1.12, 5.6, 0);
  return { pole, flag };
}

export function treeGeometry() {
  return merge([
    part(C(0.25, 0.35, 3, 5), '#5b412a', [0, 1.5, 0]),
    part(new THREE.ConeGeometry(2.2, 5, 6), '#3f5f2c', [0, 5, 0]),
    part(new THREE.ConeGeometry(1.7, 3.6, 6), '#4b6d33', [0, 7, 0]),
  ]);
}

export function rockGeometry() {
  return merge([part(new THREE.DodecahedronGeometry(1.4, 0), '#8a8579', [0, 0.5, 0], [0, 0, 0], [1.3, 0.7, 1])]);
}
