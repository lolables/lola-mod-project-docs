// Site-generator configs (mkdocs.yml, antora.yml, an Antora playbook) as
// inert data. MkDocs' `!ENV` and `!relative` tags, and the Python tags its
// plugins use (`!!python/name:…`), load as Inert {tag, value} objects:
// never resolved, imported, or run. js-yaml has no executable types, so its
// default schema can only fail on such tags; the prefix-matching definitions
// below turn every local `!…` tag and every `!!python/…` tag into data.

import { load, CORE_SCHEMA, defineScalarTag, defineSequenceTag, defineMappingTag } from './vendor/js-yaml.mjs';

export class Inert {
  constructor(tag, value) {
    this.tag = tag;
    this.value = value;
  }
}

const INERT_TAGS = ['!', 'tag:yaml.org,2002:python/'].flatMap((prefix) => [
  defineScalarTag(prefix, {
    matchByTagPrefix: true,
    resolve: (source, _explicit, tag) => new Inert(tag, source),
    identify: () => false,
  }),
  defineSequenceTag(prefix, {
    matchByTagPrefix: true,
    create: (tag) => ({ tag, items: [] }),
    addItem: (carrier, item) => { carrier.items.push(item); },
    finalize: (carrier) => new Inert(carrier.tag, carrier.items),
    identify: () => false,
  }),
  defineMappingTag(prefix, {
    matchByTagPrefix: true,
    create: (tag) => ({ tag, pairs: new Map() }),
    addPair: (carrier, key, value) => { carrier.pairs.set(key, value); return ''; },
    has: (carrier, key) => carrier.pairs.has(key),
    keys: (result) => Object.keys(result.value),
    get: (result, key) => result.value[key],
    finalize: (carrier) => new Inert(carrier.tag, Object.fromEntries(carrier.pairs)),
    identify: () => false,
  }),
]);

const SCHEMA = CORE_SCHEMA.withTags(INERT_TAGS);

// A config the user must fix (malformed, wrong shape); callers report it
// plainly and exit 2 instead of printing a stack.
export class ConfigError extends Error {}

// Generator configs rarely use aliases; the cap stops alias bombs.
const MAX_ALIASES = 50;

// The top-level mapping of `text`, the content of `path`. Throws a ConfigError
// naming `path` for malformed YAML or a document that is not a mapping, so a
// caller exits 2 rather than falling back to repo mode.
export function loadSiteYaml(path, text) {
  // js-yaml v5 rejects a document with no content; no line beyond whitespace or comments is an empty mapping.
  if (!/^[ \t]*[^#\s]/m.test(text)) return {};
  let doc;
  try {
    doc = load(text, { schema: SCHEMA, maxAliases: MAX_ALIASES });
  } catch (e) {
    throw new ConfigError(`${path}: malformed YAML: ${String(e && e.message).split('\n')[0]}`);
  }
  if (doc === null || doc === undefined) return {};
  if (typeof doc !== 'object' || Array.isArray(doc) || doc instanceof Inert) {
    throw new ConfigError(`${path}: expected a mapping at the top level`);
  }
  return doc;
}
