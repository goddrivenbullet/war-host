# War Host

A local 3D medieval battle prototype: two hosts of about 10,000 troops clash on a field you can orbit and zoom, each led by an in-game army AI that follows a data-driven fighting style.

Play the prototype at [goddrivenbullet.github.io/war-host](https://goddrivenbullet.github.io/war-host/). The source is in this repository.

> This is a local game prototype, not a historical simulation. Numbers are tuned for play, not accuracy. There is no online play, no accounts, no analytics and no network calls.

## Run it

```bash
npm install
npm run dev        # local dev server (open the URL it prints)
npm run build      # production build into dist/
npm run preview    # serve the production build locally
npm test           # headless simulation checks (Node 18+)
```

The production build in `dist/` is plain static files with relative paths. A copy in `docs/` is what GitHub Pages serves. Opening `dist/index.html` straight from disk (`file://`) is blocked by browsers for ES modules; use `npm run preview` or any static file server.

## Play

1. **Raise Your Host** → pick a battlefield, a preset or custom army for each side, a fighting style, and arms and armour.
2. **To Battle** → watch the hosts deploy, advance, clash and rout.
3. In battle: drag to orbit, scroll or pinch to zoom, right-drag (or two fingers) to pan.
   - `Space` pause (freezes the simulation), `1` / `2` / `3` speed, `R` reset view, `F` follow the fighting.
   - Change **Your orders** mid-battle to switch your host's fighting style.
4. A host is broken when every regiment has routed or fewer than 20% are still fighting. The result screen lets you fight again or change the setup.

## What's in the box

| | |
|---|---|
| Troops | Infantry (sword, spear, axe, mace), archers (short bow, longbow, crossbow), cavalry (lance, sabre, sword, mace), horse archers |
| Engines | Trebuchet and catapult (arcing stones, area damage, break walls), ballista (flat bolts that punch through a file of men) |
| Fighting styles | Shield Wall, All-Out Charge, Arrow Storm, Cavalry Flank, Feigned Retreat, Siege First |
| Battlefields | Open Plain, Rolling Hills (slopes slow you, height adds range and weight), River Crossing (deep water, three fords), Castle Approach (curtain wall, gate, posterns, breachable walls; attack or defend) |
| Presets | Iron Legion, Horse Lords, Castle Host, Hillfolk, Free Company, Steppe Wind |

## Data, not code

Everything that defines the game lives in `data/` as JSON:

- `units.json` – troop and engine stats, allowed weapons/armour/shields per type
- `weapons.json`, `armor.json` – weapon and armour/shield classes
- `styles.json` – fighting styles (formation depth and spacing, where archers and cavalry stand, how each arm behaves, aggression, morale)
- `presets.json` – preset armies
- `maps.json` – battlefield parameters

Armies can be exported and imported as `.warhost.json` files (see `examples/`). Imported files are parsed with `JSON.parse` only and validated field by field: unknown fields, unknown weapons/armour, values out of range and files over 16 KB are rejected. Nothing in an army file is ever executed.

## Layout

```
data/            game data (JSON)
src/sim/         simulation: battle.js (units, AI, combat), terrain.js, army.js (validation), rng.js
src/render/      Three.js: world.js (scene, terrain, walls), armyView.js (instanced troops, engines, missiles), models.js
src/ui/          setup screen and DOM helpers
src/main.js      screens, HUD, game loop
test/            Node tests for the simulation
```

## How the big battles run

- **Simulation** (`src/sim/battle.js`): fixed 20 Hz timestep, seeded RNG (same seed + same setup = same battle), struct-of-arrays typed arrays for every unit, and a per-side uniform-grid spatial hash for targeting and separation. Regiments (~100–200 men) carry the AI: each regiment gets orders twice a second (hold, advance, charge, flank, feint, screen, skirmish, withdraw) and every soldier follows a formation slot or fights the nearest enemy within its leash. Morale is per regiment; losses, rear attacks and nearby routs break it.
- **Missiles** are lightweight records (start, end, flight time, arc) resolved on landing; the renderer draws them as instanced meshes.
- **Rendering** (`src/render/`): one instanced draw call per troop type per side (low-poly merged meshes with vertex colours), instanced banners and missiles, procedural terrain and textures. The sim runs on the main thread with a per-frame time budget so rendering is never starved.

## License

MIT – see `LICENSE`.
