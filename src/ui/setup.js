// Pre-battle setup: battlefield, two armies, styles, loadouts, import/export.
import { h, add, select, clear } from './dom.js';
import { TROOP_TYPES, ENGINE_TYPES, MAX_ENGINES, MAX_FILE_BYTES, parseArmyText, armyToFile, presetArmy } from '../sim/army.js';

const SIDE_LABEL = ['Your Host', 'Enemy Host'];

export function buildSetup(root, data, setup, actions) {
  clear(root);
  const screen = h('div', { class: 'screen setup' });
  root.append(screen);

  const panels = [0, 1].map((s) => armyPanel(s));
  const bar = h('div', { class: 'panel setup-bar' });
  screen.append(panels[0], panels[1], bar);
  renderBar();

  function changed() { actions.onChange(); }

  function renderBar() {
    clear(bar);
    const cards = h('div', { class: 'map-cards' }, Object.entries(data.maps).map(([id, m]) =>
      h('button', { class: 'map-card' + (setup.mapId === id ? ' on' : ''), onclick: () => { setup.mapId = id; renderBar(); changed(); } },
        h('strong', {}, m.label), h('span', {}, m.blurb))));
    const castleRow = setup.mapId === 'castle'
      ? h('div', { class: 'row' }, h('label', {}, 'At the wall, your host will'),
        select([['attack', 'Attack'], ['defend', 'Defend']], setup.defend ? 'defend' : 'attack', (v) => { setup.defend = v === 'defend'; changed(); }))
      : null;
    const troops = h('input', { type: 'range', min: 2000, max: 12000, step: 1000, value: setup.troops });
    const troopsLabel = h('span', { class: 'num' }, setup.troops.toLocaleString());
    troops.addEventListener('input', () => { troopsLabel.textContent = Number(troops.value).toLocaleString(); });
    troops.addEventListener('change', () => { setup.troops = Number(troops.value); changed(); panels.forEach((p) => p.refreshCounts()); });
    const seed = h('input', { type: 'number', min: 1, max: 999999, value: setup.seed, class: 'seed' });
    seed.addEventListener('change', () => { const v = Math.max(1, Math.min(999999, Math.floor(Number(seed.value) || 1))); setup.seed = v; seed.value = v; changed(); });
    add(bar,
      h('h3', {}, 'Battlefield'), cards,
      h('div', { class: 'row wrap' },
        h('label', {}, 'Troops on the field'), troops, troopsLabel,
        h('label', { class: 'gap' }, 'Battle seed'), seed,
        h('button', { class: 'small', onclick: () => { setup.seed = 1 + Math.floor(Math.random() * 999998); seed.value = setup.seed; changed(); } }, 'Reroll')),
      castleRow,
      h('div', { class: 'row end' },
        h('button', { class: 'ghost', onclick: actions.onBack }, 'Back'),
        h('button', { class: 'primary big', onclick: actions.onStart }, 'To Battle')),
    );
  }

  function armyPanel(s) {
    const panel = h('div', { class: `panel army side${s}` });
    const body = h('div', { class: 'army-body' });
    const err = h('div', { class: 'error', role: 'alert' });
    panel.append(err, body);
    panel.refreshCounts = render;
    render();
    return panel;

    function set(fn) { fn(setup.armies[s]); setup.presetIds[s] = 'custom'; render(); changed(); }

    function render() {
      clear(body);
      const army = setup.armies[s];
      const presetOpts = [...Object.entries(data.presets).map(([id, p]) => [id, p.name]), ['custom', 'Custom']];
      const style = data.styles[army.style];
      const comp = army.composition;
      const sum = TROOP_TYPES.reduce((a, t) => a + (comp[t] || 0), 0) || 1;
      const per = Math.round(setup.troops / 2);

      const nameIn = h('input', { type: 'text', maxlength: 32, value: army.name, class: 'name' });
      nameIn.addEventListener('change', () => set((a) => { a.name = nameIn.value.replace(/[^\p{L}\p{N} '\-]/gu, '').slice(0, 32) || 'Custom Host'; }));

      add(body,
        h('div', { class: 'army-head' }, h('span', { class: 'swatch' }), h('h2', {}, SIDE_LABEL[s])),
        h('div', { class: 'row' }, h('label', {}, 'Preset'), select(presetOpts, setup.presetIds[s], (v) => {
          if (v === 'custom') return;
          setup.armies[s] = presetArmy(data, v); setup.presetIds[s] = v; render(); changed();
        })),
        h('div', { class: 'row' }, h('label', {}, 'Name'), nameIn),
        h('div', { class: 'row' }, h('label', {}, 'Fighting style'), select(Object.entries(data.styles).map(([id, st]) => [id, st.label]), army.style, (v) => set((a) => { a.style = v; }))),
        h('p', { class: 'blurb' }, style.blurb),
        h('h4', {}, 'Troops'),
        TROOP_TYPES.map((t) => {
          const r = h('input', { type: 'range', min: 0, max: 100, step: 1, value: comp[t] || 0 });
          const count = Math.round(per * (comp[t] || 0) / sum);
          r.addEventListener('change', () => set((a) => { a.composition[t] = Number(r.value); if (TROOP_TYPES.every((k) => !a.composition[k])) a.composition.infantry = 10; }));
          return h('div', { class: 'row slider' }, h('label', {}, data.units[t].label), r, h('span', { class: 'num' }, count.toLocaleString()));
        }),
        h('h4', {}, 'Siege engines'),
        h('div', { class: 'row engines' }, ENGINE_TYPES.map((e) => {
          const inp = h('input', { type: 'number', min: 0, max: MAX_ENGINES, value: army.engines[e] || 0 });
          inp.addEventListener('change', () => set((a) => { a.engines[e] = Math.max(0, Math.min(MAX_ENGINES, Math.floor(Number(inp.value) || 0))); }));
          return h('label', { class: 'eng' }, data.units[e].label, inp);
        })),
        h('h4', {}, 'Arms and armour'),
        TROOP_TYPES.map((t) => loadoutRow(t, army)),
        h('div', { class: 'row end' },
          h('button', { class: 'small', onclick: () => exportArmy(army) }, 'Export army'),
          importButton()),
      );
    }

    function loadoutRow(t, army) {
      const u = data.units[t];
      const lo = army.loadouts[t];
      const W = data.weapons[lo.weapon], A = data.armor.armor[lo.armor], S = data.armor.shields[lo.shield];
      const speed = u.walk * (u.mounted ? Math.sqrt(A.speed) : A.speed) * S.speed * (W.speed || 1);
      const stat = W.class === 'missile'
        ? `Range ${W.range} · Dmg ${W.damage} · Armour ${Math.round(A.defense * 100)}% · Speed ${speed.toFixed(1)}`
        : `Dmg ${W.damage} · Reach ${W.reach} · Armour ${Math.round(A.defense * 100)}% · Shield ${Math.round(S.melee * 100)}/${Math.round(S.missile * 100)} · Speed ${speed.toFixed(1)}`;
      return h('div', { class: 'loadout' },
        h('div', { class: 'lo-title' }, u.label),
        h('div', { class: 'lo-selects' },
          select(u.weapons.map((k) => [k, data.weapons[k].label]), lo.weapon, (v) => set((a) => { a.loadouts[t].weapon = v; }), { 'aria-label': `${u.label} weapon` }),
          select(u.armors.map((k) => [k, data.armor.armor[k].label]), lo.armor, (v) => set((a) => { a.loadouts[t].armor = v; }), { 'aria-label': `${u.label} armour` }),
          select(u.shields.map((k) => [k, data.armor.shields[k].label]), lo.shield, (v) => set((a) => { a.loadouts[t].shield = v; }), { 'aria-label': `${u.label} shield` })),
        h('div', { class: 'lo-stat' }, stat));
    }

    function exportArmy(army) {
      const blob = new Blob([armyToFile(army)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = h('a', { href: url, download: `${army.name.replace(/\s+/g, '-').toLowerCase() || 'army'}.warhost.json` });
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    }

    function importButton() {
      const file = h('input', { type: 'file', accept: '.json,application/json', style: { display: 'none' } });
      file.addEventListener('change', async () => {
        const f = file.files && file.files[0];
        file.value = '';
        if (!f) return;
        if (f.size > MAX_FILE_BYTES) { showErr([`File is too large (max ${MAX_FILE_BYTES / 1024} KB).`]); return; }
        const text = await f.text();
        const res = parseArmyText(text, data);
        if (!res.ok) { showErr(res.errors.slice(0, 6)); return; }
        setup.armies[s] = res.army; setup.presetIds[s] = 'custom';
        clear(err); err.className = 'error ok'; err.append(h('strong', {}, 'Army imported.'));
        render(); changed();
      });
      return h('span', {}, file, h('button', { class: 'small', onclick: () => file.click() }, 'Import army'));
    }

    function showErr(lines) {
      clear(err);
      err.className = 'error';
      panel.scrollTop = 0;
      err.append(h('strong', {}, 'Import refused: '), lines.join(' '));
    }
  }
}
