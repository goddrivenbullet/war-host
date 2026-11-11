import { readFileSync } from 'node:fs';
const rd = (f) => JSON.parse(readFileSync(new URL(`../data/${f}`, import.meta.url), 'utf8'));
export const data = {
  units: rd('units.json'), weapons: rd('weapons.json'), armor: rd('armor.json'),
  styles: rd('styles.json'), presets: rd('presets.json'), maps: rd('maps.json'),
};
