// Army files are plain data. This module validates and normalizes them.
// Imported files are parsed with JSON.parse only and checked field by field;
// nothing in them is ever evaluated or executed.

export const TROOP_TYPES = ['infantry', 'archers', 'cavalry', 'horseArchers'];
export const ENGINE_TYPES = ['trebuchet', 'catapult', 'ballista'];
export const ARMY_FORMAT = 'war-host-army';
export const MAX_FILE_BYTES = 16 * 1024;
export const MAX_ENGINES = 12; // per engine type

const TOP_KEYS = new Set(['format', 'version', 'name', 'style', 'composition', 'engines', 'loadouts']);
const LOADOUT_KEYS = new Set(['weapon', 'armor', 'shield']);

function cleanName(s) {
  return String(s).replace(/[^\p{L}\p{N} '\-]/gu, '').trim().slice(0, 32);
}

/**
 * Validate an army object. Returns { ok, army, errors }.
 * Unknown fields are rejected, not ignored, so a bad file is obvious.
 */
export function validateArmy(raw, data) {
  const errors = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errors: ['Army file must be a JSON object.'] };
  }
  for (const k of Object.keys(raw)) if (!TOP_KEYS.has(k)) errors.push(`Unknown field "${k}".`);
  if (raw.format !== undefined && raw.format !== ARMY_FORMAT) errors.push('Not a War Host army file.');

  const army = { name: 'Custom Host', style: 'shieldWall', composition: {}, engines: {}, loadouts: {} };
  if (raw.name !== undefined) {
    if (typeof raw.name !== 'string') errors.push('name must be text.');
    else army.name = cleanName(raw.name) || 'Custom Host';
  }
  if (raw.style !== undefined) {
    if (typeof raw.style !== 'string' || !Object.hasOwn(data.styles, raw.style)) errors.push(`Unknown style "${raw.style}".`);
    else army.style = raw.style;
  }

  const comp = raw.composition ?? {};
  if (typeof comp !== 'object' || Array.isArray(comp)) errors.push('composition must be an object.');
  else {
    for (const k of Object.keys(comp)) if (!TROOP_TYPES.includes(k)) errors.push(`Unknown troop type "${k}".`);
    let sum = 0;
    for (const t of TROOP_TYPES) {
      const v = comp[t] ?? 0;
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 100) errors.push(`composition.${t} must be 0-100.`);
      else { army.composition[t] = Math.round(v); sum += v; }
    }
    if (sum <= 0) errors.push('composition needs at least one troop type above 0.');
  }

  const eng = raw.engines ?? {};
  if (typeof eng !== 'object' || Array.isArray(eng)) errors.push('engines must be an object.');
  else {
    for (const k of Object.keys(eng)) if (!ENGINE_TYPES.includes(k)) errors.push(`Unknown engine "${k}".`);
    for (const t of ENGINE_TYPES) {
      const v = eng[t] ?? 0;
      if (!Number.isInteger(v) || v < 0 || v > MAX_ENGINES) errors.push(`engines.${t} must be a whole number 0-${MAX_ENGINES}.`);
      else army.engines[t] = v;
    }
  }

  const lo = raw.loadouts ?? {};
  if (typeof lo !== 'object' || Array.isArray(lo)) errors.push('loadouts must be an object.');
  else {
    for (const k of Object.keys(lo)) if (!TROOP_TYPES.includes(k)) errors.push(`Unknown loadout "${k}".`);
    for (const t of TROOP_TYPES) {
      const u = data.units[t];
      const src = lo[t] ?? {};
      if (typeof src !== 'object' || Array.isArray(src)) { errors.push(`loadouts.${t} must be an object.`); continue; }
      for (const k of Object.keys(src)) if (!LOADOUT_KEYS.has(k)) errors.push(`Unknown field "${k}" in loadouts.${t}.`);
      const pick = (key, list) => {
        const v = src[key];
        if (v === undefined) return list[0];
        if (typeof v !== 'string' || !list.includes(v)) { errors.push(`loadouts.${t}.${key} "${v}" is not allowed for ${u.label}.`); return list[0]; }
        return v;
      };
      army.loadouts[t] = { weapon: pick('weapon', u.weapons), armor: pick('armor', u.armors), shield: pick('shield', u.shields) };
    }
  }
  return errors.length ? { ok: false, errors } : { ok: true, army, errors: [] };
}

/** Parse untrusted text from an imported file. */
export function parseArmyText(text, data) {
  if (typeof text !== 'string') return { ok: false, errors: ['Could not read file.'] };
  if (text.length > MAX_FILE_BYTES) return { ok: false, errors: [`File is too large (max ${MAX_FILE_BYTES / 1024} KB).`] };
  let raw;
  try { raw = JSON.parse(text); } catch { return { ok: false, errors: ['File is not valid JSON.'] }; }
  return validateArmy(raw, data);
}

export function armyToFile(army) {
  return JSON.stringify({ format: ARMY_FORMAT, version: 1, ...structuredClone(army) }, null, 2);
}

export function presetArmy(data, id) {
  const p = data.presets[id];
  const r = validateArmy(p, data);
  if (!r.ok) throw new Error(`Bad preset ${id}: ${r.errors.join(' ')}`);
  return r.army;
}
