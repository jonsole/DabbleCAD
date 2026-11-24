// A small JSON Schema checker for the AI tool inputs: the subset the tool schemas use (object,
// array, string, number, integer, boolean, enum, required, additionalProperties: false, plus
// minimum / maximum, which some providers can't enforce themselves). Returns a list of problems.

export function checkSchema(schema, value, path = 'input') {
  const out = [];
  check(schema, value, path, out);
  return out;
}

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}

function check(s, v, path, out) {
  if (!s) return;
  if (s.anyOf) {
    if (!s.anyOf.some((alt) => checkSchema(alt, v, path).length === 0)) out.push(`${path} doesn't match any allowed form`);
    return;
  }
  const t = typeOf(v);
  const types = Array.isArray(s.type) ? s.type : s.type ? [s.type] : null;
  if (types) {
    const ok = types.some((want) => want === t || (want === 'number' && t === 'integer'));
    if (!ok) { out.push(`${path} should be ${types.join(' or ')}, not ${t}`); return; }
  }
  if (s.enum && !s.enum.includes(v)) { out.push(`${path} should be one of ${s.enum.map((x) => JSON.stringify(x)).join(', ')}`); return; }
  if (t === 'number' || t === 'integer') {
    if (!Number.isFinite(v)) { out.push(`${path} should be a finite number`); return; }
    if (s.minimum != null && v < s.minimum) out.push(`${path} should be at least ${s.minimum}`);
    if (s.maximum != null && v > s.maximum) out.push(`${path} should be at most ${s.maximum}`);
    if (s.exclusiveMinimum != null && v <= s.exclusiveMinimum) out.push(`${path} should be more than ${s.exclusiveMinimum}`);
  }
  if (t === 'string') {
    if (s.minLength != null && v.length < s.minLength) out.push(`${path} should not be empty`);
    if (s.maxLength != null && v.length > s.maxLength) out.push(`${path} is too long (at most ${s.maxLength} characters)`);
  }
  if (t === 'array') {
    if (s.minItems != null && v.length < s.minItems) out.push(`${path} needs at least ${s.minItems} item${s.minItems === 1 ? '' : 's'}`);
    if (s.maxItems != null && v.length > s.maxItems) out.push(`${path} has too many items (at most ${s.maxItems})`);
    if (s.items) v.forEach((x, i) => check(s.items, x, `${path}[${i}]`, out));
  }
  if (t === 'object') {
    const props = s.properties || {};
    for (const k of s.required || []) if (!(k in v) || v[k] === undefined) out.push(`${path}.${k} is required`);
    for (const [k, x] of Object.entries(v)) {
      if (props[k]) check(props[k], x, `${path}.${k}`, out);
      else if (s.additionalProperties === false) out.push(`${path}.${k} is not a known field`);
      else if (s.additionalProperties && typeof s.additionalProperties === 'object') check(s.additionalProperties, x, `${path}.${k}`, out);
    }
  }
}

/** The schema with the keywords some providers reject (bounds, lengths) removed, for sending. */
export function wireSchema(s) {
  if (!s || typeof s !== 'object') return s;
  if (Array.isArray(s)) return s.map(wireSchema);
  const out = {};
  for (const [k, v] of Object.entries(s)) {
    if (['minimum', 'maximum', 'exclusiveMinimum', 'minLength', 'maxLength', 'minItems', 'maxItems'].includes(k)) continue;
    out[k] = k === 'properties' ? Object.fromEntries(Object.entries(v).map(([pk, pv]) => [pk, wireSchema(pv)])) : wireSchema(v);
  }
  return out;
}
