// ── Names ─────────────────────────────────────────────────────────────────────

// The Rust target's names, as Buffa 0.9.2 gives them (decision 0051), repeated here for the paths
// beadc writes beside Buffa's tree and for the tree's root it writes itself: snake case, Buffa's
// `to_snake_case` (`oneof.rs`, the Rust API Guidelines' C-CASE, an acronym one word); a keyword
// as a raw identifier, `r#type`, or with Buffa's `_` where Rust holds no raw one, `self_`
// (`idents.rs`, `escape_mod_ident` and `make_field_ident`); a package's file and its module root's
// file (`lib.rs`, `package_to_filename` and `package_to_mod_filename`); and the module a message's
// nested types live in, deconflicted against the sub-packages that share its scope
// (`context.rs`). A rendering keeps its key: the descriptor's name never moves (decision 0022). The
// goldens, compiled against Buffa's own output, hold these to Buffa's. This module imports nothing,
// so `config.ts` reads it without loading the target.

// constants

/** The module Buffa names the unnamed package's files after, and its ancillary trees. */
export const SENTINEL_MOD = '__buffa';

// ! Buffa's `is_rust_keyword`, every edition's strict and reserved keywords up to 2024's `gen`
const KEYWORDS: ReadonlySet<string> = new Set([
  'as',
  'break',
  'const',
  'continue',
  'crate',
  'else',
  'enum',
  'extern',
  'false',
  'fn',
  'for',
  'if',
  'impl',
  'in',
  'let',
  'loop',
  'match',
  'mod',
  'move',
  'mut',
  'pub',
  'ref',
  'return',
  'self',
  'Self',
  'static',
  'struct',
  'super',
  'trait',
  'true',
  'type',
  'unsafe',
  'use',
  'where',
  'while',
  'async',
  'await',
  'dyn',
  'gen',
  'abstract',
  'become',
  'box',
  'do',
  'final',
  'macro',
  'override',
  'priv',
  'try',
  'typeof',
  'unsized',
  'virtual',
  'yield',
]);

// the keywords a path holds, which no raw identifier takes
const PATH_KEYWORDS: ReadonlySet<string> = new Set(['self', 'super', 'Self', 'crate']);

// helpers

const isUpper = (character: string): boolean => {
  return character !== character.toLowerCase() && character === character.toUpperCase();
};

const isLower = (character: string): boolean => {
  return character !== character.toUpperCase() && character === character.toLowerCase();
};

// definition

/** Whether `name` is a Rust keyword, strict or reserved, in any edition up to 2024. */
export const isRustKeyword = (name: string): boolean => {
  return KEYWORDS.has(name);
};

/**
 * `name` in snake case, as Buffa's `to_snake_case` writes it: `_` before an upper-case letter that
 * follows a lower-case one, and before the last of a run of capitals a lower-case letter follows,
 * every letter lowered: `getHTTPStatus2` → `get_http_status2`, `XMLHttp` → `xml_http`.
 */
export const toSnakeCase = (name: string): string => {
  const characters = Array.from(name);

  return characters
    .map((character, at) => {
      const previous = characters[at - 1];
      const next = characters[at + 1];
      const breaks =
        at > 0 &&
        isUpper(character) &&
        previous !== undefined &&
        (isLower(previous) || (isUpper(previous) && next !== undefined && isLower(next)));

      return `${breaks ? '_' : ''}${character.toLowerCase()}`;
    })
    .join('');
};

/**
 * `name` as a Rust identifier, as Buffa's `escape_mod_ident` and `make_field_ident` write one: a
 * keyword raw, `r#type`, or, where Rust holds no raw form, `self`, `super`, `Self` and `crate`,
 * with `_` after it, `self_`; any other name as it is.
 */
export const identifierOf = (name: string): string => {
  if (!isRustKeyword(name)) {
    return name;
  }

  return PATH_KEYWORDS.has(name) ? `${name}_` : `r#${name}`;
};

/** The field, method part or module a name of Bead's takes: its snake case, as an identifier. */
export const snakeIdentifierOf = (name: string): string => {
  return identifierOf(toSnakeCase(name));
};

/** A package's file, as Buffa's `package_to_filename` names it: `hello.v1.rs`, `__buffa.rs`. */
export const packageToFilename = (packageName: string): string => {
  return packageName === '' ? `${SENTINEL_MOD}.rs` : `${packageName}.rs`;
};

/** A package's module root, as Buffa's `package_to_mod_filename` names it: `hello.v1.mod.rs`. */
export const packageToModFilename = (packageName: string): string => {
  return packageName === '' ? `${SENTINEL_MOD}.mod.rs` : `${packageName}.mod.rs`;
};

/**
 * The module of each top-level message of a package, as Buffa's `deconflict_package_modules`
 * names it: its snake case, or, where a sub-package of the package's scope takes that name, `_`
 * after it until no sub-package, no message's own snake case, `__buffa` nor a name given before
 * takes it, the colliding messages given theirs in their snake cases' order.
 */
export const nestedModulesOf = (
  messages: readonly string[],
  children: ReadonlySet<string>
): string[] => {
  const bases = messages.map(toSnakeCase);
  const taken = new Set([...children, SENTINEL_MOD, ...bases]);
  const modules = [...bases];
  const order = bases
    .map((base, at) => {
      return { base, at };
    })
    .toSorted((one, other) => {
      return one.base < other.base ? -1 : Number(one.base > other.base);
    });

  for (const { base, at } of order) {
    if (children.has(base)) {
      let candidate = `${base}_`;

      while (taken.has(candidate)) {
        candidate = `${candidate}_`;
      }

      taken.add(candidate);
      modules[at] = candidate;
    }
  }

  return modules;
};

/**
 * Each segment of the packages a set holds directly under `packageName`, which share its module's
 * scope with its messages' modules, as Buffa's `child_package_segments` gathers them.
 */
export const childSegmentsOf = (
  packageName: string,
  packages: Iterable<string>
): ReadonlySet<string> => {
  const prefix = packageName === '' ? '' : `${packageName}.`;
  const children = new Set<string>();

  for (const each of packages) {
    if (each.startsWith(prefix) && each.length > prefix.length) {
      children.add(each.slice(prefix.length).split('.')[0] ?? '');
    }
  }

  return children;
};
