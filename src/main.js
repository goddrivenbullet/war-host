import './style.css';
import * as THREE from 'three';
import { data } from './data.js';
import { Battle, DT } from './sim/battle.js';
import { presetArmy } from './sim/army.js';
import { createStage, buildField } from './render/world.js';
import { ArmyView } from './render/armyView.js';
import { buildSetup } from './ui/setup.js';
import { h, select, clear, fmtTime } from './ui/dom.js';

const canvas = document.getElementById('view');
const ui = document.getElementById('ui');
const stage = createStage(canvas);
const { scene, camera, controls, renderer } = stage;

const setup = {
  mapId: 'plain',
  defend: false,
  troops: 10000,
  seed: 1 + Math.floor(Math.random() * 999998),
  presetIds: ['ironLegion', 'freeCompany'],
  armies: [presetArmy(data, 'ironLegion'), presetArmy(data, 'freeCompany')],
};

let mode = 'title';
let battle = null, field = null, view = null;
let paused = true, speed = 1, acc = 0;
let follow = false, shadows = true;
let hud = null;
let resultShown = false;
let previewTimer = 0;

// ------------------------------------------------------------------ battle lifecycle
function build() {
  if (view) { view.dispose(); view = null; }
  if (field) { scene.remove(field.group); field.dispose(); field = null; }
  battle = new Battle({
    data, mapId: setup.mapId, armies: setup.armies, seed: setup.seed, troops: setup.troops,
    defender: setup.mapId === 'castle' ? (setup.defend ? 0 : 1) : 1,
  });
  field = buildField(battle.terrain, setup.seed);
  scene.add(field.group);
  view = new ArmyView(scene, battle, field, { shadows, onEvent });
  acc = 0;
  view.update(1, performance.now() / 1000);
}

function homeView(instant = true) {
  const s = battle.sides[0];
  const d = s.dir;
  const T = battle.terrain;
  const tx = s.cx * 0.5, tz = s.cz + d * 70;
  const target = new THREE.Vector3(tx, T.heightAt(tx, tz), tz);
  const pos = new THREE.Vector3(tx + 70, target.y + 85, s.cz - d * 150);
  if (instant) { controls.target.copy(target); camera.position.copy(pos); }
  else { camTween = { from: camera.position.clone(), fromT: controls.target.clone(), to: pos, toT: target, t: 0 }; }
  controls.update();
}
let camTween = null;

function schedulePreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(() => { build(); homeView(); }, 250);
}

// ------------------------------------------------------------------ screens
function showTitle() {
  mode = 'title'; paused = true;
  clear(ui);
  controls.autoRotate = true; controls.autoRotateSpeed = 0.35;
  ui.append(h('div', { class: 'screen title' },
    h('div', { class: 'title-card' },
      h('h1', {}, 'WAR HOST'),
      h('p', { class: 'tag' }, 'Raise your host. Choose the field. Break their line.'),
      h('div', { class: 'title-buttons' },
        h('button', { class: 'primary big', onclick: showSetup }, 'Raise Your Host'),
        h('button', { class: 'big', onclick: quickBattle }, 'Quick Battle')),
      h('p', { class: 'fine' }, 'Drag to turn the view · Scroll or pinch to zoom · Right-drag to pan'))));
}

function quickBattle() {
  const ids = Object.keys(data.presets);
  const maps = Object.keys(data.maps);
  const a = ids[Math.floor(Math.random() * ids.length)];
  let b = ids[Math.floor(Math.random() * ids.length)];
  if (b === a) b = ids[(ids.indexOf(a) + 1) % ids.length];
  setup.presetIds = [a, b];
  setup.armies = [presetArmy(data, a), presetArmy(data, b)];
  setup.mapId = maps[Math.floor(Math.random() * maps.length)];
  setup.seed = 1 + Math.floor(Math.random() * 999998);
  startBattle();
}

function showSetup() {
  mode = 'setup'; paused = true;
  controls.autoRotate = true; controls.autoRotateSpeed = 0.25;
  buildSetup(ui, data, setup, { onChange: schedulePreview, onStart: startBattle, onBack: showTitle });
}

function startBattle() {
  clearTimeout(previewTimer);
  build();
  homeView();
  controls.autoRotate = false;
  mode = 'battle'; paused = false; speed = 1; resultShown = false; follow = false;
  showHud();
}

// ------------------------------------------------------------------ HUD
function showHud() {
  clear(ui);
  const sideCard = (s) => {
    const el = h('div', { class: `side-card side${s}` },
      h('div', { class: 'sc-name' }), h('div', { class: 'sc-style' }),
      h('div', { class: 'bar' }, h('div', { class: 'fill' })),
      h('div', { class: 'sc-nums' }),
      h('div', { class: 'bar morale' }, h('div', { class: 'fill' })));
    return el;
  };
  const cards = [sideCard(0), sideCard(1)];
  const clock = h('div', { class: 'clock' }, '0:00');
  const pauseBtn = h('button', { onclick: togglePause, title: 'Pause (Space)' }, 'Pause');
  const speedBtns = [1, 2, 4].map((v) => h('button', { class: 'speed', onclick: () => setSpeed(v), title: `Speed ${v}x` }, `${v}x`));
  const styleSel = select(Object.entries(data.styles).map(([id, st]) => [id, st.label]), battle.sides[0].styleId, (v) => {
    battle.setStyle(0, v); toast(`New orders: ${data.styles[v].label}`);
  }, { 'aria-label': 'Your fighting style' });
  const followBtn = h('button', { onclick: () => { follow = !follow; followBtn.classList.toggle('on', follow); }, title: 'Follow the fighting (F)' }, 'Follow');
  const shadowBtn = h('button', { class: shadows ? 'on' : '', onclick: () => setShadows(!shadows) }, 'Shadows');
  const stats = h('div', { class: 'perf' });
  const toasts = h('div', { class: 'toasts' });
  const top = h('div', { class: 'hud-top' }, cards[0], h('div', { class: 'mid' }, clock, h('div', { class: 'paused-tag' }, 'PAUSED')), cards[1]);
  const bottom = h('div', { class: 'hud-bottom panel' },
    pauseBtn, h('span', { class: 'speeds' }, speedBtns),
    h('span', { class: 'sep' }),
    h('label', {}, 'Your orders'), styleSel,
    h('span', { class: 'sep' }),
    h('button', { onclick: () => homeView(false), title: 'Reset view (R)' }, 'Reset view'), followBtn, shadowBtn,
    h('span', { class: 'sep' }),
    h('button', { class: 'ghost', onclick: () => { if (confirm('Leave this battle?')) showSetup(); } }, 'Leave'));
  ui.append(h('div', { class: 'screen hud' }, top, bottom, stats, toasts));
  hud = { cards, clock, pauseBtn, speedBtns, styleSel, stats, toasts, followBtn, shadowBtn, fpsT: 0, frames: 0, fps: 60, slow: 0 };
  setSpeed(1);
  updateHud(true);
}

function setShadows(on) {
  shadows = on;
  view?.setShadows(on);
  renderer.shadowMap.needsUpdate = true;
  hud?.shadowBtn.classList.toggle('on', on);
}

function togglePause() {
  if (mode !== 'battle') return;
  paused = !paused;
  hud.pauseBtn.textContent = paused ? 'Resume' : 'Pause';
  ui.querySelector('.hud')?.classList.toggle('is-paused', paused);
}
function setSpeed(v) {
  speed = v;
  hud?.speedBtns.forEach((b) => b.classList.toggle('on', b.textContent === `${v}x`));
}

function toast(text) {
  if (!hud) return;
  const el = h('div', { class: 'toast' }, text);
  hud.toasts.append(el);
  setTimeout(() => el.classList.add('out'), 2600);
  setTimeout(() => el.remove(), 3300);
  while (hud.toasts.children.length > 4) hud.toasts.firstChild.remove();
}

function onEvent(ev) {
  if (mode !== 'battle') return;
  if (ev.type === 'breach') toast('The wall is breached!');
  else if (ev.type === 'feint') toast(ev.extra === 0 ? 'Your line falls back… on purpose.' : 'The enemy line falls back!');
  else if (ev.type === 'rout') toast(ev.extra === 0 ? 'One of your regiments breaks and runs!' : 'An enemy regiment breaks!');
}

function updateHud(force = false) {
  if (!hud || !battle) return;
  hud.frames++;
  const now = performance.now();
  if (!force && now - hud.fpsT < 250) return;
  const dtw = (now - hud.fpsT) / 1000;
  if (hud.fpsT) hud.fps = hud.frames / dtw;
  hud.frames = 0; hud.fpsT = now;
  const stats = battle.stats();
  stats.forEach((s, k) => {
    const c = hud.cards[k];
    c.querySelector('.sc-name').textContent = s.name;
    c.querySelector('.sc-style').textContent = s.style;
    c.querySelector('.bar .fill').style.width = `${(100 * s.fighting) / s.start}%`;
    c.querySelector('.morale .fill').style.width = `${100 * Math.min(1, s.morale)}%`;
    c.querySelector('.sc-nums').textContent = `${s.fighting.toLocaleString()} standing · ${s.dead.toLocaleString()} fallen · ${(s.routing + s.fled).toLocaleString()} fled`;
  });
  hud.clock.textContent = fmtTime(battle.t);
  const alive = stats[0].fighting + stats[1].fighting + stats[0].routing + stats[1].routing;
  hud.stats.textContent = `${Math.round(hud.fps)} fps · ${alive.toLocaleString()} on the field · ${battle.pCount} missiles`;
  if (hud.styleSel.value !== battle.sides[0].styleId) hud.styleSel.value = battle.sides[0].styleId;
  // auto quality: drop shadows if the frame rate sags
  if (!paused && hud.fps < 26) hud.slow++; else hud.slow = Math.max(0, hud.slow - 1);
  if (hud.slow > 12 && shadows) { setShadows(false); toast('Shadows off to keep things smooth'); hud.slow = 0; }
}

function showResult() {
  resultShown = true;
  const r = battle.result;
  const s = r.stats;
  const title = r.winner === 0 ? 'Victory' : r.winner === 1 ? 'Defeat' : 'Stalemate';
  const sub = r.winner === -1 ? 'Neither host could break the other.'
    : r.reason === 'time' ? 'The light failed. The field is held by the stronger host.'
      : r.winner === 0 ? `${s[1].name} is broken and flees the field.` : `${s[0].name} is broken. The day is lost.`;
  const row = (label, f) => h('tr', {}, h('th', {}, label), h('td', {}, f(s[0])), h('td', {}, f(s[1])));
  const box = h('div', { class: 'screen result' }, h('div', { class: 'panel result-card ' + (r.winner === 0 ? 'win' : r.winner === 1 ? 'loss' : '') },
    h('h1', {}, title), h('p', { class: 'tag' }, sub),
    h('table', {},
      h('tr', {}, h('th', {}), h('th', { class: 'side0' }, s[0].name), h('th', { class: 'side1' }, s[1].name)),
      row('Fighting style', (x) => x.style),
      row('Marched out', (x) => x.start.toLocaleString()),
      row('Still standing', (x) => x.fighting.toLocaleString()),
      row('Fallen', (x) => x.dead.toLocaleString()),
      row('Fled', (x) => (x.fled + x.routing).toLocaleString()),
      row('Engines left', (x) => x.engines)),
    h('p', { class: 'fine' }, `Battle lasted ${fmtTime(r.time)} on the ${data.maps[setup.mapId].label}.`),
    h('div', { class: 'row end' },
      h('button', { class: 'ghost', onclick: () => { box.remove(); } }, 'Watch the field'),
      h('button', { onclick: showSetup }, 'Change setup'),
      h('button', { class: 'primary', onclick: () => { setup.seed = 1 + Math.floor(Math.random() * 999998); startBattle(); } }, 'Fight again'))));
  ui.append(box);
}

// ------------------------------------------------------------------ input
window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
  if (mode !== 'battle') return;
  if (e.code === 'Space') { e.preventDefault(); togglePause(); }
  else if (e.key === '1') setSpeed(1);
  else if (e.key === '2') setSpeed(2);
  else if (e.key === '3' || e.key === '4') setSpeed(4);
  else if (e.key === 'r' || e.key === 'R') homeView(false);
  else if (e.key === 'f' || e.key === 'F') hud?.followBtn.click();
});
document.addEventListener('visibilitychange', () => { if (document.hidden && mode === 'battle' && !paused) togglePause(); });

// ------------------------------------------------------------------ loop
let last = performance.now();
const focus = new THREE.Vector3();
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (battle && mode === 'battle' && !paused) {
    acc += dt * speed;
    const t0 = performance.now();
    while (acc >= DT) {
      battle.step();
      acc -= DT;
      if (performance.now() - t0 > 28) { acc = 0; break; } // never let the sim starve the renderer
    }
    if (battle.ended && !resultShown && battle.t - battle.endT > 4) showResult();
  }
  const alpha = mode === 'battle' && !paused ? acc / DT : 1;
  if (view) view.update(Math.min(1, alpha), now / 1000);

  if (camTween) {
    camTween.t = Math.min(1, camTween.t + dt * 1.6);
    const e = 1 - Math.pow(1 - camTween.t, 3);
    camera.position.lerpVectors(camTween.from, camTween.to, e);
    controls.target.lerpVectors(camTween.fromT, camTween.toT, e);
    if (camTween.t >= 1) camTween = null;
  } else if (follow && battle && mode === 'battle') {
    // drift toward where the fighting is thickest
    let n = 0, fx = 0, fz = 0;
    for (const r of battle.regs) if (r.engaged > 0 && !r.routing) { fx += r.cx * r.engaged; fz += r.cz * r.engaged; n += r.engaged; }
    if (n === 0) { const s = battle.sides[0]; fx = s.cx; fz = s.cz + s.dir * 60; n = 1; }
    focus.set(fx / n, 0, fz / n);
    focus.y = battle.terrain.heightAt(focus.x, focus.z);
    const delta = focus.sub(controls.target).multiplyScalar(Math.min(1, dt * 0.8));
    controls.target.add(delta); camera.position.add(delta);
  }
  controls.update();
  renderer.render(scene, camera);
  if (mode === 'battle') updateHud();
}

build();
homeView();
showTitle();
requestAnimationFrame(frame);

// small hook for automated smoke tests (read-only)
window.__warhost = { get battle() { return battle; }, get view() { return view; }, get mode() { return mode; }, start: startBattle, setup, camera, controls };
