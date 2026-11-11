// All game data lives in /data as plain JSON so it can be edited without touching code.
import units from '../data/units.json';
import weapons from '../data/weapons.json';
import armor from '../data/armor.json';
import styles from '../data/styles.json';
import presets from '../data/presets.json';
import maps from '../data/maps.json';

export const data = { units, weapons, armor, styles, presets, maps };
