/**
 * Upgrade an OpenAPI 3.0 spec to 3.1 in place (design §6.3).
 *
 * Covers the changes that matter in practice:
 * - `openapi: 3.0.x` becomes `3.1.0`;
 * - `nullable: true` becomes a `null` entry in `type`;
 * - boolean `exclusiveMinimum` / `exclusiveMaximum` become numbers.
 * Edits go through SpecDoc, so only the touched lines change.
 */
const walkSchemas = (node, keys, visit) => {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    node.forEach((child, i) => walkSchemas(child, [...keys, i], visit));
    return;
  }
  visit(node, keys);
  for (const [k, v] of Object.entries(node)) {
    if (v && typeof v === 'object') walkSchemas(v, [...keys, k], visit);
  }
};

const upgradeTo31 = (specDoc) => {
  const version = String(specDoc.get(['openapi']) || '');
  if (!/^3\.0\./.test(version)) return false;
  specDoc.set(['openapi'], '3.1.0');

  const js = specDoc.toJS();
  const edits = [];
  walkSchemas(js, [], (node, keys) => {
    if (node.nullable === true || node.nullable === false) {
      edits.push(() => {
        if (node.nullable === true && node.type) {
          const types = Array.isArray(node.type) ? node.type : [node.type];
          if (!types.includes('null')) specDoc.set([...keys, 'type'], [...types, 'null']);
        }
        specDoc.delete([...keys, 'nullable']);
      });
    }
    for (const [flag, bound] of [['exclusiveMinimum', 'minimum'], ['exclusiveMaximum', 'maximum']]) {
      if (typeof node[flag] === 'boolean') {
        edits.push(() => {
          if (node[flag] && typeof node[bound] === 'number') {
            specDoc.set([...keys, flag], node[bound]);
            specDoc.delete([...keys, bound]);
          } else {
            specDoc.delete([...keys, flag]);
          }
        });
      }
    }
  });
  edits.forEach((e) => e());
  return true;
};

module.exports = { upgradeTo31 };
