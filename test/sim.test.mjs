// Headless checks for the War Host simulation. Run: npm test
import assert from 'node:assert/strict';
import { data } from './load-data.mjs';
import { Battle, S_FORM, S_FIGHT } from '../src/sim/battle.js';
import { presetArmy, parseArmyText, validateArmy, armyToFile, MAX_FILE_BYTES } from '../src/sim/army.js';

let passed = 0;
const test = (name, fn) => {
  const t0 = performance.now();
  fn();
  passed++;
  console.log(`ok - ${name} (${((performance.now() - t0) / 1000).toFixed(1)}s)`);
};

const make = (a, b, opts = {}) => new Battle({
  data, mapId: opts.map || 'plain', seed: opts.seed ?? 3, troops: opts.troops ?? 10000,
  armies: [presetArmy(data, a), presetArmy(data, b)].map((x, i) => (opts.styles?.[i] ? { ...x, style: opts.styles[i] } : x)),
  defender: opts.defender,
});
const run = (bt, maxT = 960) => { while (!bt.ended && bt.t < maxT) bt.step(); return bt; };
const finite = (bt) => { for (let i = 0; i < bt.N; i++) if (!Number.isFinite(bt.x[i]) || !Number.isFinite(bt.z[i])) return false; return true; };

test('all presets validate', () => {
  for (const id of Object.keys(data.presets)) assert.ok(presetArmy(data, id));
});

test('a 10,000-troop battle deploys, steps and ends with a winner', () => {
  const bt = make('ironLegion', 'freeCompany');
  const troops = bt.regs.filter((r) => r.kind !== 'engine').reduce((a, r) => a + r.start, 0);
  assert.equal(troops, 10000);
  let alive = 0;
  for (let i = 0; i < bt.N; i++) if (bt.st[i] === S_FORM || bt.st[i] === S_FIGHT) alive++;
  assert.equal(alive, bt.N);
  const t0 = performance.now();
  for (let k = 0; k < 200; k++) bt.step();
  const ms = (performance.now() - t0) / 200;
  console.log(`   avg step ${ms.toFixed(2)} ms for ${bt.N} units`);
  run(bt);
  assert.ok(bt.ended, 'battle should end');
  assert.ok([0, 1, -1].includes(bt.result.winner));
  assert.ok(finite(bt), 'positions stay finite');
  const s = bt.stats();
  assert.ok(s[0].dead + s[1].dead > 500, 'troops actually fell');
});

test('same seed gives the same battle (deterministic)', () => {
  const a = run(make('hillfolk', 'horseLords', { seed: 11 }), 60);
  const b = run(make('hillfolk', 'horseLords', { seed: 11 }), 60);
  assert.deepEqual(Array.from(a.x.slice(0, 500)), Array.from(b.x.slice(0, 500)));
  assert.deepEqual(a.stats(), b.stats());
});

test('fighting styles change the outcome', () => {
  // identical armies; only the style differs
  const outcomes = {};
  for (const style of ['shieldWall', 'allOutCharge', 'arrowStorm', 'cavalryFlank', 'feignedRetreat', 'siegeFirst']) {
    const bt = run(make('freeCompany', 'freeCompany', { styles: [style, 'allOutCharge'], seed: 5 }));
    const s = bt.stats();
    outcomes[style] = { winner: bt.result.winner, t: Math.round(bt.t), lost: s[0].dead, killed: s[1].dead, lastMelee: Math.round(bt.sides[0].lastMeleeT) };
  }
  console.log('  ', JSON.stringify(outcomes));
  const sig = new Set(Object.values(outcomes).map((o) => `${o.winner}:${Math.round(o.lost / 100)}:${Math.round(o.t / 10)}`));
  assert.ok(sig.size >= 4, 'styles should produce clearly different battles');
});

test('every battlefield runs with every preset pairing without breaking', () => {
  const ids = Object.keys(data.presets);
  for (const map of Object.keys(data.maps)) {
    for (let k = 0; k < ids.length; k++) {
      const bt = make(ids[k], ids[(k + 1) % ids.length], { map, troops: 3000, seed: k + 1 });
      for (let s = 0; s < 600; s++) bt.step();
      assert.ok(finite(bt), `${map} ${ids[k]} finite`);
    }
  }
});

test('river: nobody walks through deep water', () => {
  const bt = make('freeCompany', 'freeCompany', { map: 'river', troops: 4000, seed: 2 });
  for (let s = 0; s < 1600; s++) {
    bt.step();
    if (s % 50 === 0) for (let i = 0; i < bt.N; i++) {
      if (bt.st[i] === 0) continue;
      // allow for float32 rounding right at a ford edge
      const T = bt.terrain, x = bt.x[i], z = bt.z[i];
      assert.ok(!(T.isDeep(x - 0.05, z) && T.isDeep(x + 0.05, z) && T.isDeep(x, z)), 'unit in deep water');
    }
  }
});

test('castle: engines can breach the wall', () => {
  const bt = make('castleHost', 'ironLegion', { map: 'castle', seed: 4, defender: 1 });
  run(bt, 300);
  const breaches = bt.terrain.walls.filter((w) => !w.alive).length;
  assert.ok(breaches >= 1, 'expected at least one breach');
});

test('army import: valid file round-trips', () => {
  const army = presetArmy(data, 'hillfolk');
  const res = parseArmyText(armyToFile(army), data);
  assert.ok(res.ok, res.errors.join(' '));
  assert.deepEqual(res.army, army);
});

test('army import: rejects unknown fields, bad enums, code and oversize files', () => {
  const base = JSON.parse(armyToFile(presetArmy(data, 'ironLegion')));
  const bad = (mut) => { const o = structuredClone(base); mut(o); return validateArmy(o, data); };
  assert.equal(bad((o) => { o.script = 'alert(1)'; }).ok, false);
  assert.equal(bad((o) => { o.loadouts.infantry.weapon = 'laser'; }).ok, false);
  assert.equal(bad((o) => { o.loadouts.archers.weapon = 'lance'; }).ok, false, 'weapon must fit troop type');
  assert.equal(bad((o) => { o.loadouts.infantry.onHit = 'function(){}'; }).ok, false);
  assert.equal(bad((o) => { o.composition.dragons = 5; }).ok, false);
  assert.equal(bad((o) => { o.engines.trebuchet = 999; }).ok, false);
  assert.equal(bad((o) => { o.composition.infantry = -4; }).ok, false);
  assert.equal(bad((o) => { o.style = 'constructor'; }).ok, false);
  assert.equal(bad((o) => { o.__proto__ = { x: 1 }; }).ok, true, 'assigning __proto__ does not add a field');
  assert.equal(parseArmyText('{"__proto__": {"polluted": 1}}', data).ok, false);
  assert.equal(({}).polluted, undefined);
  assert.equal(parseArmyText('not json', data).ok, false);
  assert.equal(parseArmyText(' '.repeat(MAX_FILE_BYTES + 1), data).ok, false);
  const named = bad((o) => { o.name = '<img src=x onerror=alert(1)>'; });
  assert.ok(named.ok && !/[<>=]/.test(named.army.name), 'names are stripped to plain text');
});

console.log(`\n${passed} checks passed`);
