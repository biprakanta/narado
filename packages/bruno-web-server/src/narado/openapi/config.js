/**
 * narado's folder in a collection: `.narado/` next to the OpenAPI spec.
 *
 *   services/payments/api/
 *     payments-v2.yaml          the spec, any name
 *     .narado/
 *       config.nar              marks the collection and names the spec (YAML)
 *       requests/<operationId>.yml
 *       allowed-hosts.yml
 *
 * config.nar:
 *
 *   version: 1
 *   name: Payments API          optional; defaults to the spec's info.title
 *   spec: payments-v2.yaml      relative to the folder holding .narado/
 *   grpc:                       optional; for gRPC requests (see .narado/extra/)
 *     protoFiles: [../../proto/payments.proto]   relative to this folder, inside the repo
 *     importPaths: [../../proto]
 *
 * GraphQL, gRPC and WebSocket requests, which OpenAPI can't describe, are kept as Bruno
 * files in .narado/extra/, in the same folders as in the collection.
 *
 * Without config.nar, a folder is a collection when it holds openapi.yaml, openapi.yml
 * or openapi.json (in that order). Collections made before `.narado/` keep their files
 * in `.client/`, which is still read and written for them.
 */
const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');

const NARADO_DIR = '.narado';
const LEGACY_DIR = '.client';
const CONFIG_NAME = 'config.nar';
const CONFIG_FILE = `${NARADO_DIR}/${CONFIG_NAME}`;
const SPEC_FILES = ['openapi.yaml', 'openapi.yml', 'openapi.json'];
const SPEC_EXT = /\.(?:ya?ml|json)$/i;

class ConfigError extends Error {}

/** Parse and check config.nar's text. Throws ConfigError with a message for people. */
const parseConfig = (text, where = CONFIG_FILE) => {
  let doc;
  try {
    doc = YAML.parse(String(text || '')) || {};
  } catch (err) {
    throw new ConfigError(`${where} is not valid YAML: ${err.message}`);
  }
  if (typeof doc !== 'object' || Array.isArray(doc)) throw new ConfigError(`${where} must be a YAML mapping`);
  const version = doc.version === undefined ? 1 : doc.version;
  if (version !== 1) throw new ConfigError(`${where}: version ${version} is not supported (use 1)`);
  const out = { version: 1, name: null, spec: null, grpc: { protoFiles: [], importPaths: [] } };
  if (doc.name !== undefined && doc.name !== null) {
    if (typeof doc.name !== 'string' || !doc.name.trim()) throw new ConfigError(`${where}: name must be text`);
    out.name = doc.name.trim();
  }
  if (doc.spec !== undefined && doc.spec !== null) {
    if (typeof doc.spec !== 'string') throw new ConfigError(`${where}: spec must be a file name`);
    const spec = path.posix.normalize(doc.spec.trim().replace(/\\/g, '/'));
    // The spec lives in the collection's folder or below it, never outside.
    if (!spec || spec === '.' || spec.startsWith('../') || spec === '..' || path.posix.isAbsolute(spec) || spec.startsWith(`${NARADO_DIR}/`)) {
      throw new ConfigError(`${where}: spec must be a path inside the collection's folder`);
    }
    if (!SPEC_EXT.test(spec)) throw new ConfigError(`${where}: spec must be a .yaml, .yml or .json file`);
    out.spec = spec;
  }
  if (doc.grpc !== undefined && doc.grpc !== null) {
    if (typeof doc.grpc !== 'object' || Array.isArray(doc.grpc)) throw new ConfigError(`${where}: grpc must be a mapping`);
    for (const key of ['protoFiles', 'importPaths']) {
      const list = doc.grpc[key] === undefined || doc.grpc[key] === null ? [] : doc.grpc[key];
      if (!Array.isArray(list) || list.some((x) => typeof x !== 'string' || !x.trim())) throw new ConfigError(`${where}: grpc.${key} must be a list of paths`);
      out.grpc[key] = list.map((x) => {
        const p = path.posix.normalize(x.trim().replace(/\\/g, '/'));
        if (path.posix.isAbsolute(p)) throw new ConfigError(`${where}: grpc.${key} paths must be relative to the collection's folder`);
        return p;
      });
    }
  }
  return out;
};

/**
 * Set config.nar's grpc lists, keeping the rest of the file (and its comments) as it is.
 * Creates config.nar when there is none.
 */
const writeGrpcConfig = (dir, { protoFiles = [], importPaths = [] }) => {
  const file = path.join(dir, NARADO_DIR, CONFIG_NAME);
  const doc = fs.existsSync(file) ? YAML.parseDocument(fs.readFileSync(file, 'utf8')) : new YAML.Document({ version: 1 });
  if (!protoFiles.length && !importPaths.length) doc.delete('grpc');
  else {
    doc.setIn(['grpc', 'protoFiles'], protoFiles);
    doc.setIn(['grpc', 'importPaths'], importPaths);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const text = doc.toString();
  fs.writeFileSync(file, text);
  return text;
};

/** The collection's config, or null without one. Throws ConfigError when it is invalid. */
const readConfig = (dir) => {
  const file = path.join(dir, NARADO_DIR, CONFIG_NAME);
  if (!fs.existsSync(file)) return null;
  return parseConfig(fs.readFileSync(file, 'utf8'), path.relative(dir, file) || CONFIG_FILE);
};

/**
 * The spec file for a folder: the one config.nar names, else openapi.yaml/.yml/.json.
 * Returns null when there is none. An invalid config, or one naming a missing spec, throws.
 */
const findSpec = (dir) => {
  const config = readConfig(dir);
  if (config && config.spec) {
    const p = path.join(dir, ...config.spec.split('/'));
    if (!fs.existsSync(p)) throw new ConfigError(`${CONFIG_FILE} names ${config.spec}, which is not in ${path.basename(dir) || 'the folder'}`);
    return p;
  }
  for (const name of SPEC_FILES) {
    const p = path.join(dir, name);
    if (fs.existsSync(p)) return p;
  }
  return null;
};

/** findSpec that answers null instead of throwing (for "is this an OpenAPI folder?"). */
const findSpecQuiet = (dir) => {
  try {
    return findSpec(dir);
  } catch {
    return null;
  }
};

/** Name of narado's folder for a collection: `.narado`, or `.client` for older ones. */
const dataDirName = (dir) => (!fs.existsSync(path.join(dir, NARADO_DIR)) && fs.existsSync(path.join(dir, LEGACY_DIR)) ? LEGACY_DIR : NARADO_DIR);

/** Is this repo path narado's folder (either name)? */
const isNaradoDir = (name) => name === NARADO_DIR || name === LEGACY_DIR;

module.exports = { NARADO_DIR, LEGACY_DIR, CONFIG_NAME, CONFIG_FILE, SPEC_FILES, ConfigError, parseConfig, readConfig, writeGrpcConfig, findSpec, findSpecQuiet, dataDirName, isNaradoDir };
