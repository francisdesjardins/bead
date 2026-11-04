#!/usr/bin/env node
// A public name is one on every side, in each language's case, or a row of `tools/names.tsv` says
// how it renders, why it is one side's own, or which row of `docs/support.md`'s Differences holds
// it (decision 0004). The rows are read against the surface lists each side pins: the TypeScript
// side's `implementations/typescript/surface.txt`, each C# project's `PublicAPI.Shipped.txt` with
// its `PublicAPI.Unshipped.txt` applied, and the Rust side's lists under
// `implementations/rust/crates/bead-house/surfaces/`, which `tools/surface-lists.mjs` reads.
//
//   node tools/check-names.mjs           the rows against the three lists
//   node tools/check-names.mjs --seed    writes tools/names.tsv anew from the lists
//
// ! the seed writes over every row a reading placed: it starts the file, and the file is kept by
// hand after it
//
// A row is one concept, tab-separated: the concept, its names on the TypeScript, C# and Rust sides,
// `-` for none, and its class. A cell holds one name or several, by commas, each with its kind in
// brackets, read from its side's list; a Rust variant is written `Enum::Variant`. Its first name
// is the concept's, and the others stand beside it, as a TypeScript `create…` factory beside its
// type. The class is one of these:
//
//   same                             the names agree under the case rules, and their kinds render
//                                    each other
//   rendered: <rule> (<records>)     one name is another's by a rule a record states
//   own: <reason> (<record>)         one side's alone, as the record allows
//   differs: <title>                 a difference to close, the title a row of docs/support.md's
//                                    Differences
//   alone                            a name one side alone holds and no reading has placed yet
//
// The names a side alone holds are counted against the pin of the file's first line,
// `# alone: typescript <n>, csharp <n>, rust <n>`, which may only fall: a count past its pin
// fails, and so does one under it until the pin is lowered. A new public name takes a class other
// than `alone`. ! A rename that drops one `alone` row and adds another keeps the count, so such a
// swap is held by the review of the file's diff alone.
//
// What a side's list names: on the TypeScript side, each name an entry exports; on the C# side,
// each public type, but a static class, whose static methods, constants and static properties are
// names of their own, `Holder.Member`; a static class of constants alone is one name, as a frozen
// object is on the TypeScript side; and every other type's constants, `Type.Name`; on the Rust
// side, each name a crate's root exports and each item of a public module, `json::read`, a foreign
// type re-exported aside. Members are left to each side's own surface test. A kind is read from
// the declaration: a TypeScript interface with a call signature is a function's type or a record,
// as 0007 holds a callable that carries members, and a primitive branded a record, as a newtype is;
// a Rust newtype whose associated constants are its values a choice, the open code space 0044
// states, and an alias of a primitive a scalar. Exit 1 on a problem, each with its line.

import { writeFileSync } from 'node:fs';

import {
  differencesOf,
  listsOf,
  publicLinesOf,
  readOf,
  ROOT,
  SIDES,
  SUPPORT,
  topLevel,
} from './surface-lists.mjs';

export { differencesOf, publicLinesOf, SIDES };

const NAMES = 'tools/names.tsv';

// ── Kinds ──────────────────────────────────────────────────────────────────────

// * the kind table: the kinds each side's cell may carry under one row of it, so one concept. A
// C# class, record or struct is a `record`, which also renders a choice (0007's "a sealed record
// holding one of its arms"); a Rust variant renders a record of the others; a scalar is a
// TypeScript or a Rust alias of a primitive, which C# writes as the primitive itself
export const KIND_TABLE = Object.freeze({
  record: { typescript: ['record'], csharp: ['record'], rust: ['record'] },
  choice: { typescript: ['choice'], csharp: ['choice', 'record'], rust: ['choice'] },
  'function type': {
    typescript: ['function type'],
    csharp: ['function type'],
    rust: ['function type'],
  },
  function: { typescript: ['function'], csharp: ['function'], rust: ['function'] },
  constant: { typescript: ['constant'], csharp: ['constant'], rust: ['constant'] },
  scalar: { typescript: ['scalar'], csharp: [], rust: ['scalar'] },
  variant: { typescript: ['record'], csharp: ['record'], rust: ['variant'] },
});

export const KINDS = Object.freeze(Object.keys(KIND_TABLE));

// a kind's class: a value and a type of one spelling, `BROKER_PUBLISHED` and `BrokerPublished`,
// are never one key
const VALUES = new Set(['function', 'constant']);

const classOf = (kind) => {
  return VALUES.has(kind) ? 'value' : 'type';
};

/** Whether one row of the kind table admits the kind of each side's cell, `{ side: kind }`. */
export const kindsRender = (kinds) => {
  const sides = Object.keys(kinds);

  return Object.values(KIND_TABLE).some((row) => {
    return sides.every((side) => {
      return row[side].includes(kinds[side]);
    });
  });
};

// ── TypeScript ─────────────────────────────────────────────────────────────────

const PRIMITIVE =
  /^(?:number|string|boolean|bigint|symbol|'[^']*'|"[^"]*"|`[^`]*`|-?\d+(?:\.\d+)?)$/;

// a function's type: `(…) => …`, a generic one, or one with members, `((…) => …) & {…}`
const isFunctionType = (text) => {
  const body = text.replace(/^\((.*)\)( & \{.*\})?$/, '$1');

  return /^(?:<.*?>)?\(/.test(body) && topLevel(body, '=>').length > 1;
};

// the kinds of a type alias, by its right side; a reference to another declaration, by its kinds
const aliasKindsOf = (name, right, kindsOf) => {
  const body = right.replace(/^\|\s*/, '');
  const reference = body.match(/^([A-Za-z_$][\w$]*)(?:<.*>)?$/);

  // ! a function first: a union its return type is, `(…) => | A | B`, is no choice of its own
  if (isFunctionType(body)) {
    return ['function type'];
  }
  if (topLevel(body, '|').length > 1) {
    return ['choice'];
  }
  if (/^keyof\s/.test(body) || /^\(typeof \w+\)\[keyof typeof \w+\]$/.test(body)) {
    return ['choice'];
  }
  if (body === `typeof ${name}`) {
    return ['constant'];
  }
  // a primitive branded, `string & {readonly [brand]: …}`, is a type of its own, as a newtype is
  if (/^(?:string|number) & \{/.test(body)) {
    return ['record'];
  }
  if (PRIMITIVE.test(body)) {
    return ['scalar'];
  }
  if (reference !== null && reference[1] !== name) {
    return kindsOf(reference[1]) ?? ['record'];
  }

  return ['record'];
};

// the kinds of a constant, by its declaration: a function, or a constant whose type is one; a
// frozen table named as a type, as `ProtocolCode` is, a choice; and any other a constant
const constantKindsOf = (name, declaration, kindsOf) => {
  const typed = declaration.match(/^const \w+: (.*)$/);

  if (new RegExp(`^const ${name}(?:<.*?>)?[(]`).test(declaration)) {
    return ['function'];
  }
  if (typed !== null && isFunctionType(typed[1])) {
    return ['function'];
  }
  if (typed !== null && /^[A-Za-z_$][\w$]*(?:<.*>)?$/.test(typed[1])) {
    const reference = typed[1].replace(/<.*$/, '');

    if (kindsOf(reference)?.includes('function type')) {
      return ['function'];
    }
  }
  if (/^[A-Z][a-z]/.test(name) && /^const \w+: Readonly<\{/.test(declaration)) {
    return ['choice'];
  }

  return ['constant'];
};

/**
 * The TypeScript side's names, `name → { kinds }`: each name an entry exports, its kind read from
 * its declaration; a name declared in several modules, a constant each, is one. An interface with a
 * call signature is a function's type or a record, as 0007 holds a callable that carries members.
 */
export const typeScriptNamesOf = (text) => {
  const lines = text.split('\n');
  const exported = new Set();
  const declared = new Map();

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const entry = line.match(/^ {2}([A-Za-z_$][\w$]*)\t\S+$/);
    const header = line.match(/^src\/\S+ ([A-Za-z_$][\w$]*)$/);

    if (entry !== null) {
      exported.add(entry[1]);
    } else if (header !== null) {
      const declaration = (lines[index + 1] ?? '').replace(/^ {2}/, '');
      const first = (lines[index + 2] ?? '').replace(/^ {4}/, '');

      declared.set(header[1], [...(declared.get(header[1]) ?? []), { declaration, first }]);
    }
  }

  const resolved = new Map();
  const kindsOf = (name, seen = new Set()) => {
    if (resolved.has(name)) {
      return resolved.get(name);
    }
    if (!declared.has(name) || seen.has(name)) {
      return null;
    }
    seen.add(name);

    const found = new Set();

    for (const { declaration, first } of declared.get(name)) {
      const alias = declaration.match(/^type \w+(?:<.*?>)? = (.*)$/);
      const lookup = (other) => {
        return kindsOf(other, seen);
      };
      const kinds = alias
        ? aliasKindsOf(name, alias[1], lookup)
        : declaration.startsWith('const ')
          ? constantKindsOf(name, declaration, lookup)
          : declaration.startsWith('interface ') && /^(?:<.*?>)?\(/.test(first)
            ? ['function type', 'record']
            : ['record'];

      found.add(kinds.join('|'));
    }

    // several declarations, a constant in each module that declares one, are a constant
    const kinds = found.size === 1 ? [...found][0].split('|') : ['constant'];

    resolved.set(name, kinds);

    return kinds;
  };

  return new Map(
    [...exported].map((name) => {
      return [name, { kinds: kindsOf(name) ?? ['record'] }];
    })
  );
};

// ── C# ─────────────────────────────────────────────────────────────────────────

const MODIFIERS = /^~?(?:(?:abstract|static|virtual|override|const|sealed|readonly) )*/;

// a line's type arguments as their arity, C#'s `typeof` form: `ProcedureBindings<TRequest, TResult>`
// is `ProcedureBindings<,>`, so a generic type and a plain one of one name stay two types
const arityOf = (line) => {
  let text = line;

  while (/<[^<>]*>/.test(text)) {
    text = text.replace(/<([^<>]*)>/g, (_, inner) => {
      return `\u0001${','.repeat(inner.split(',').length - 1)}\u0002`;
    });
  }

  return text.replace(/\u0001(,*)\u0002/g, '<$1>');
};

// a member line's owner and its member's name, a type's own line giving none
const memberOf = (line, types) => {
  const head = line.replace(MODIFIERS, '').split(/[( ]/)[0];
  const parts = head.split('.');

  for (let end = parts.length - 1; end > 0; end--) {
    const owner = parts.slice(0, end).join('.');

    if (types.has(owner)) {
      return { owner, member: parts[end].replace(/<,*>$/, '') };
    }
  }

  return null;
};

/**
 * The C# side's names, `name → { kinds }`, from the public lines of every project: each type, by the
 * name its namespace leaves, but a static class, whose static members are names `Holder.Member`,
 * unless it holds constants alone, and then it is one constant; and each other type's constants. A
 * generic type keeps its arity, `INotificationResolver<>`, where a type of its name without it is
 * public too.
 */
export const cSharpNamesOf = (lines) => {
  const normalized = lines.map((line) => {
    return arityOf(line.replace(/^~/, ''));
  });
  const types = new Set(
    normalized.filter((line) => {
      return /^[A-Z][\w.]*(?:<,*>)?$/.test(line);
    })
  );
  const members = new Map([...types].map((type) => [type, []]));

  for (const line of normalized) {
    const found = memberOf(line, types);

    if (found !== null) {
      members.get(found.owner).push({ line, member: found.member });
    }
  }

  const bare = (type) => {
    return type.replace(/<,*>$/, '');
  };
  const arities = new Map();

  for (const type of types) {
    arities.set(bare(type), (arities.get(bare(type)) ?? 0) + 1);
  }

  // a type's name: what its namespace leaves, a nested type keeping its owner, its arity kept
  // where another type has its name
  const nameOf = (type) => {
    const parts = type.split('.');
    let start = parts.length - 1;

    while (start > 0 && types.has(parts.slice(0, start).join('.'))) {
      start--;
    }

    const name = parts.slice(start).join('.');

    return arities.get(bare(type)) > 1 ? name : bare(name);
  };

  const names = new Map();

  for (const type of types) {
    const owned = members.get(type);
    const name = nameOf(type);
    const holder = bare(name);
    const isStatic =
      owned.length > 0 &&
      owned.every(({ line }) => {
        return /^(?:static|const) /.test(line);
      });
    const isTable =
      isStatic &&
      owned.every(({ line }) => {
        return /^(?:const |static readonly )/.test(line);
      });

    if (isTable) {
      names.set(name, { kinds: ['constant'] });
      continue;
    }
    for (const { line, member } of owned) {
      if (/^(?:const|static readonly) /.test(line)) {
        names.set(`${holder}.${member}`, { kinds: ['constant'] });
      } else if (isStatic && /^static /.test(line)) {
        const isMethod = /\(/.test(line.split(' -> ')[0]) && !/\.(?:get|set|init) ->/.test(line);

        names.set(`${holder}.${member}`, { kinds: [isMethod ? 'function' : 'constant'] });
      }
    }
    if (isStatic) {
      continue;
    }

    const isEnum = owned.some(({ line }) => {
      return / = -?\d+ -> /.test(line) && !/^const /.test(line);
    });
    const isDelegate = owned.some(({ line, member }) => {
      return member === 'Invoke' && /^virtual /.test(line);
    });

    names.set(name, { kinds: [isEnum ? 'choice' : isDelegate ? 'function type' : 'record'] });
  }

  return names;
};

// ── Rust ───────────────────────────────────────────────────────────────────────

// the kind of a type alias, by its right side: a function's type, a primitive, or a record
const rustAliasKindOf = (right) => {
  if (/^(?:Arc|Box)<dyn (?:Fn|FnMut|FnOnce)\b/.test(right) || /^fn\(/.test(right)) {
    return 'function type';
  }
  if (
    /^(?:(?:Arc|Box|Rc)<str>|String|&'static str|bool|char|[iu](?:8|16|32|64|128|size)|f(?:32|64))$/.test(
      right
    )
  ) {
    return 'scalar';
  }

  return 'record';
};

// one list's sections, `path → Map(name → { kind, variants, target })`, `target` for a `use`
const sectionsOf = (text) => {
  const sections = new Map();
  let items = null;
  let item = null;

  for (const line of text.split('\n')) {
    if (/^\S/.test(line)) {
      items = new Map();
      sections.set(line.trim(), items);
      item = null;
      continue;
    }
    if (items === null) {
      continue;
    }

    const top = line.match(/^ {2}(\S.*)$/);

    if (top !== null) {
      const declaration = top[1];
      const use = declaration.match(/^use ((?:\w+::)*)(\w+)$/);
      const typed = declaration.match(/^(struct|enum|trait|type|mod) (\w+)(.*)$/);
      const valued = declaration.match(/^(?:const |static |async |unsafe )*fn (\w+)/);
      const constant = declaration.match(/^(?:const|static) (\w+):/);

      item = null;
      if (use !== null) {
        items.set(use[2], { kind: 'use', target: use[1].replace(/::$/, '') });
      } else if (typed !== null) {
        const [, keyword, name, rest] = typed;

        if (keyword === 'mod') {
          if (!rest.includes('#[doc(hidden)]')) {
            items.set(name, { kind: 'mod' });
          }
        } else {
          const kind =
            keyword === 'enum'
              ? 'choice'
              : keyword === 'type'
                ? rustAliasKindOf(rest.replace(/^(?:<.*?>)? = /, ''))
                : 'record';

          item = { keyword, kind, variants: new Set() };
          items.set(name, item);
        }
      } else if (valued !== null) {
        items.set(valued[1], { kind: 'function' });
      } else if (constant !== null) {
        items.set(constant[1], { kind: 'constant' });
      }
      continue;
    }

    const variant = line.match(/^ {4}([A-Z]\w*)(?:[({].*)?$/);

    if (item !== null && item.keyword === 'enum' && variant !== null) {
      item.variants.add(variant[1]);
    }
    // a newtype whose associated constants are its values is a choice: a code space the spec
    // keeps open (0044), as `ProtocolCode` is
    if (
      item !== null &&
      item.keyword === 'struct' &&
      /^ {4}const [A-Z][A-Z0-9_]*: Self$/.test(line)
    ) {
      item.kind = 'choice';
    }
  }

  return sections;
};

/**
 * The Rust side's names, `name → { kinds, variants }`: each name a crate's root exports, its kind
 * read where the name is defined, and each item of a public module, `module::name`; a foreign type
 * re-exported, which no section defines, is left out.
 */
export const rustNamesOf = (texts) => {
  const names = new Map();

  for (const text of texts) {
    const sections = sectionsOf(text);

    // a name's definition, a `use` followed to the section that defines it
    const resolve = (section, name, depth = 0) => {
      const found = sections.get(section)?.get(name);

      if (found === undefined || depth > 16) {
        return null;
      }
      if (found.kind === 'use') {
        return found.target === ''
          ? null
          : (resolve(`${section}::${found.target}`, name, depth + 1) ??
              resolve(`crate::${found.target}`, name, depth + 1));
      }

      return found;
    };

    const visit = (section, prefix) => {
      for (const [name, found] of sections.get(section) ?? []) {
        if (found.kind === 'mod') {
          visit(`${section}::${name}`, `${prefix}${name}::`);
          continue;
        }

        const defined = resolve(section, name);

        if (defined !== null) {
          names.set(`${prefix}${name}`, { kinds: [defined.kind], variants: defined.variants });
        }
      }
    };

    visit('crate', '');
  }

  return names;
};

// ── The lists ──────────────────────────────────────────────────────────────────

/** The three sides' names, read from the lists under `root`. */
export const surfacesOf = (root = ROOT) => {
  const lists = listsOf(root);

  return {
    typescript: typeScriptNamesOf(lists.typescript),
    csharp: cSharpNamesOf(lists.csharp),
    rust: rustNamesOf(lists.rust),
  };
};

// ── The case rules ─────────────────────────────────────────────────────────────

// a name's last segment: a Rust module's item, `json::read`, is keyed by `read`
const lastOf = (name) => {
  return name.split('::').at(-1);
};

/**
 * A name's key under the case rules: its case and its `_` dropped, and an interface's `I`. A C#
 * static member keeps its holder, so `Holder.Name` joins `HOLDER_NAME` by a rendering alone.
 */
export const keyOf = (name, kind) => {
  const last = arityless(lastOf(name));
  const bare = classOf(kind) === 'type' && /^I[A-Z]/.test(last) ? last.slice(1) : last;

  return bare.replace(/_/g, '').toLowerCase();
};

const FACTORY = /^create(?=[A-Z])/;

// a C# name without its arity, `INotificationResolver<>` as `INotificationResolver`
const arityless = (name) => {
  return name.replace(/<,*>$/, '');
};

// ── The renderings ─────────────────────────────────────────────────────────────

// a C# static member's keys, `Holder.Member`: its holder and member, and its member alone; none
// for a name that has no holder
const heldKeysOf = (name, kind) => {
  const [holder, member] = name.split('.');

  return member === undefined ? [] : [keyOf(`${holder}${member}`, kind), keyOf(member, kind)];
};

// a key's stem, `suffix` dropped from its end, or none where it does not end so
const stemOf = (key, ...suffixes) => {
  const suffix = suffixes.find((one) => {
    return key.endsWith(one) && key.length > one.length;
  });

  return suffix === undefined ? [] : [key.slice(0, -suffix.length)];
};

// whether every side's first name keeps a key the others keep, under `keysOf(side, cell)`
const agree = (cells, keysOf) => {
  const sets = SIDES.filter((side) => {
    return cells[side].length > 0;
  }).map((side) => {
    return keysOf(side, cells[side][0]);
  });

  return (
    sets.length > 1 &&
    sets.slice(1).every((keys) => {
      return keys.some((key) => {
        return sets[0].includes(key);
      });
    })
  );
};

// a Rust variant's keys: its own, and, where its first word is a regular English participle, the
// stems it may come of, as std's `io::ErrorKind::TimedOut` names the end a timeout met: -ed or -d
// taken off, and a doubled last consonant single again, `Disconnected` a disconnect, `Cancelled` a
// cancel, `TimedOut` a timeout (0044)
//
// ! a stem that is no word, `Disconnecte`, matches only a name no side writes, and a row is placed
// by hand, under review
const endOf = (variant, kind) => {
  const [first, ...rest] = variant.split(/(?=[A-Z])/);
  const stems = [first.replace(/ed$/, ''), first.replace(/d$/, '')]
    .filter((stem) => {
      return stem !== first;
    })
    .flatMap((stem) => {
      return /([b-df-hj-np-tv-z])\1$/i.test(stem) ? [stem, stem.slice(0, -1)] : [stem];
    });
  const names = [
    variant,
    ...stems.map((stem) => {
      return `${stem}${rest.join('')}`;
    }),
  ];

  return names.map((name) => {
    return keyOf(name, kind);
  });
};

/**
 * The renderings, each the rule a record states: whether the row's first names, `{ side: [{ name,
 * kind }] }`, render each other by it.
 */
export const RULES = Object.freeze({
  // a TypeScript `…Error` is C#'s `…Exception`, and a Rust `…Error` or an error enum's variant,
  // named as the error or as the end the operation met (0007, 0044)
  error: (cells) => {
    return agree(cells, (side, { name, kind }) => {
      if (kind === 'variant') {
        return endOf(name.split('::')[1], kind);
      }

      return stemOf(keyOf(name, kind), side === 'csharp' ? 'exception' : 'error');
    });
  },
  // a TypeScript interface an object meets by its shape is `I…Like`, as C#'s interface `I…` is
  // its own type (0007)
  like: (cells) => {
    return agree(cells, (side, { name, kind }) => {
      if (side === 'csharp') {
        return /^I[A-Z]/.test(name) ? [keyOf(name, kind)] : [];
      }
      if (side === 'rust') {
        return [keyOf(name, kind)];
      }

      return /^I[A-Z].*Like$/.test(name) ? stemOf(keyOf(name, kind), 'like') : [];
    });
  },
  // a `[Flags]` enum is plural on the C# side (0007)
  flags: (cells) => {
    return agree(cells, (side, { name, kind }) => {
      if (side !== 'csharp') {
        return [keyOf(name, kind)];
      }

      return kind === 'choice' ? stemOf(keyOf(name, kind), 's') : [];
    });
  },
  // a constant `HOLDER_NAME` is C#'s `Holder.Name` (0007)
  constant: (cells) => {
    return agree(cells, (side, { name, kind }) => {
      if (kind !== 'constant') {
        return [];
      }

      return side === 'csharp' ? heldKeysOf(name, kind) : [keyOf(name, kind)];
    });
  },
  // a function `nounOf` is C#'s `Noun.Of`, or `NounOf` on a static class that holds several, and
  // Rust's `noun_of` (0007, 0044)
  of: (cells) => {
    return agree(cells, (side, { name, kind }) => {
      if (kind !== 'function') {
        return [];
      }

      return side === 'csharp' ? heldKeysOf(name, kind) : [keyOf(name, kind)];
    });
  },
  // an event the others emit is a Rust `…Listener` or `on_…` (0044)
  listener: (cells) => {
    return agree(cells, (side, { name, kind }) => {
      const key = keyOf(name, kind);

      if (side === 'rust') {
        return name.startsWith('on_') ? [key.slice('on'.length)] : stemOf(key, 'listener');
      }

      return [...stemOf(key, 'callback', 'eventmap', 'events', 'event', 'listener'), key];
    });
  },
  // a TypeScript `type` is Rust's `…_type`, `type` being its keyword (0044)
  keyword: (cells) => {
    return agree(cells, (side, { name, kind }) => {
      const key = keyOf(name, kind);

      return side === 'rust' ? stemOf(key, 'type') : [key, ...stemOf(key, 'type')];
    });
  },
  // a platform's own type, as `IClock` is `TimeProvider` (0011): its record alone holds it
  platform: () => {
    return true;
  },
});

// ── The rows ───────────────────────────────────────────────────────────────────

const CELL = /^(\S+) \[([a-z ]+)\]$/;

const cellOf = (text) => {
  if (text === '-') {
    return [];
  }

  return text.split(', ').map((part) => {
    const found = part.match(CELL);

    return found === null ? { name: part, kind: null } : { name: found[1], kind: found[2] };
  });
};

const classOfRow = (text) => {
  const found = text.match(/^(same|alone|rendered|own|differs)(?:: (.*))?$/);

  if (found === null) {
    return { name: null };
  }

  const [, name, rest = ''] = found;
  const cited = rest.match(/^(.*?)\s*\((\d{4}(?:, \d{4})*)\)$/);

  return {
    name,
    rest,
    reason: cited === null ? rest : cited[1],
    records: cited === null ? [] : cited[2].split(', '),
  };
};

/** The file's pins and rows, each row with its line. */
export const rowsOf = (text) => {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const pin = (lines[0] ?? '').match(/^# alone: typescript (\d+), csharp (\d+), rust (\d+)$/);
  const rows = [];

  lines.forEach((line, index) => {
    if (line === '' || line.startsWith('#')) {
      return;
    }

    const fields = line.split('\t');

    rows.push({
      line: index + 1,
      fields: fields.length,
      concept: fields[0],
      cells: {
        typescript: cellOf(fields[1] ?? '-'),
        csharp: cellOf(fields[2] ?? '-'),
        rust: cellOf(fields[3] ?? '-'),
      },
      class: classOfRow(fields[4] ?? ''),
    });
  });

  return {
    pins:
      pin === null
        ? null
        : { typescript: Number(pin[1]), csharp: Number(pin[2]), rust: Number(pin[3]) },
    rows,
  };
};

// the sides a row names
const sidesOf = (row) => {
  return SIDES.filter((side) => {
    return row.cells[side].length > 0;
  });
};

// whether a list holds a cell's name, as a kind it reads it as
const holds = (names, { name, kind }) => {
  if (kind === 'variant') {
    const [owner, variant] = name.split('::');

    return names.get(owner)?.variants?.has(variant) === true;
  }

  return names.get(name)?.kinds.includes(kind) === true;
};

// whether the names beside a cell's first stand beside it under the case rules: a TypeScript
// `create…` factory beside its type, and a C# generic type beside the type of its name,
// `INotificationResolver<>` beside `INotificationResolver`
const besideHeld = (cell) => {
  const [first, ...others] = cell;

  return others.every(({ name, kind }) => {
    return kind === 'function'
      ? FACTORY.test(name) &&
          keyOf(name.replace(FACTORY, ''), 'record') === keyOf(first.name, first.kind)
      : kind === first.kind && arityless(name) === arityless(first.name);
  });
};

// each side's first kind, `{ side: kind }`
const kindsOf = (row) => {
  return Object.fromEntries(
    sidesOf(row).map((side) => {
      return [side, row.cells[side][0].kind];
    })
  );
};

const unkinded = (row) => {
  return `its kinds do not render each other (${Object.values(kindsOf(row)).join(', ')}): no row of the kind table admits them`;
};

// the problems of one row's class
const classProblemsOf = (row) => {
  const sides = sidesOf(row);
  const written = row.class;
  const renders = kindsRender(kindsOf(row));

  switch (written.name) {
    case 'same': {
      const keys = new Set(
        sides.map((side) => {
          const [first] = row.cells[side];

          return keyOf(first.name, first.kind);
        })
      );

      if (sides.length < 2) {
        return ["a `same` row names two sides or three; one side's name is `own` or `alone`"];
      }
      if (keys.size > 1 || !sides.every((side) => besideHeld(row.cells[side]))) {
        return ['its names differ under the case rules: a rendering, a difference, or two rows'];
      }

      return renders ? [] : [unkinded(row)];
    }
    case 'rendered': {
      const rule = RULES[written.reason];

      if (rule === undefined) {
        return [`no rendering named "${written.reason}": ${Object.keys(RULES).join(', ')}`];
      }
      if (written.records.length === 0) {
        return [
          `the rendering ${written.reason} names the records that state it, "rendered: ${written.reason} (<record>)"`,
        ];
      }
      if (sides.length < 2) {
        return ['a rendering names two sides or three'];
      }
      if (!rule(row.cells)) {
        return [`the rendering ${written.reason} does not give its names`];
      }

      // ! a platform's own type is held by its record alone, its kind with it
      return renders || written.reason === 'platform' ? [] : [unkinded(row)];
    }
    case 'own': {
      const problems = sides.length === 1 ? [] : ['an `own` row names one side alone'];

      return written.reason === '' || written.records.length === 0
        ? [
            ...problems,
            'an `own` row gives its reason and the record that allows it, "own: <reason> (<record>)"',
          ]
        : problems;
    }
    case 'differs':
      return [];
    case 'alone': {
      if (sides.length !== 1 || row.cells[sides[0]].length !== 1) {
        return ["an `alone` row holds one side's one name"];
      }

      return written.rest === ''
        ? []
        : ['an `alone` row gives no reason; one with a reason is `own`'];
    }
    default:
      return [
        'its class is same, rendered: <rule> (<records>), own: <reason> (<record>), differs: <title> or alone',
      ];
  }
};

/**
 * The problems of `text`, the rows, against the lists' names, `{ side: name → { kinds } }`, and the
 * titles of the Differences, each a line of text.
 */
export const problemsOf = (text, surfaces, differences) => {
  const { pins, rows } = rowsOf(text);
  const problems = [];
  const report = (row, message) => {
    problems.push(`${NAMES}:${row.line}: ${message}`);
  };
  const held = Object.fromEntries(SIDES.map((side) => [side, new Map()]));
  const concepts = new Map();
  const alone = { typescript: 0, csharp: 0, rust: 0 };

  if (pins === null) {
    problems.push(
      `${NAMES}:1: the first line pins the names each side alone holds, "# alone: typescript <n>, csharp <n>, rust <n>"`
    );
  }

  for (const row of rows) {
    const sides = sidesOf(row);

    if (row.fields !== 5) {
      report(
        row,
        `${row.fields} field(s); a row holds five, tab-separated: the concept, its TypeScript, C# and Rust names, and its class`
      );
      continue;
    }
    if (concepts.has(row.concept)) {
      report(row, `the concept ${row.concept} is also line ${concepts.get(row.concept)}'s`);
    }
    concepts.set(row.concept, row.line);
    if (sides.length === 0) {
      report(row, 'no name on any side');
      continue;
    }

    let isKinded = true;

    for (const side of sides) {
      for (const cell of row.cells[side]) {
        if (!KINDS.includes(cell.kind)) {
          report(
            row,
            `${side}'s ${cell.name} has no kind of the table, "<name> [<kind>]": ${KINDS.join(', ')}`
          );
          isKinded = false;
          continue;
        }

        const listed = surfaces[side].get(
          cell.kind === 'variant' ? cell.name.split('::')[0] : cell.name
        );

        if (!holds(surfaces[side], cell)) {
          report(
            row,
            listed === undefined || cell.kind === 'variant'
              ? `${side}'s list no longer holds ${cell.name}`
              : `${side}'s list holds ${cell.name} as a ${listed.kinds.join(' or a ')}, not a ${cell.kind}`
          );
        }
        if (held[side].has(cell.name)) {
          report(row, `${side}'s ${cell.name} is also line ${held[side].get(cell.name)}'s`);
        }
        held[side].set(cell.name, row.line);
      }
    }
    if (!isKinded) {
      continue;
    }
    for (const problem of classProblemsOf(row)) {
      report(row, problem);
    }
    if (row.class.name === 'differs' && !differences.has(row.class.rest)) {
      report(
        row,
        `"${row.class.rest}" is no row of ${SUPPORT}'s Differences; a difference is a row there, with its test`
      );
    }
    if (row.class.name === 'alone' && sides.length === 1) {
      alone[sides[0]]++;
    }
  }

  for (const side of SIDES) {
    for (const [name, { kinds }] of surfaces[side]) {
      if (!held[side].has(name)) {
        problems.push(
          `${NAMES}: ${side}'s public ${kinds[0]} ${name} is in no row; give it one, never \`alone\``
        );
      }
    }
  }

  if (pins !== null) {
    for (const side of SIDES) {
      if (alone[side] > pins[side]) {
        problems.push(
          `${NAMES}:1: ${alone[side]} \`alone\` row(s) on the ${side} side, past its pin of ${pins[side]}; a new name takes same, rendered, own or differs`
        );
      } else if (alone[side] < pins[side]) {
        problems.push(
          `${NAMES}:1: ${alone[side]} \`alone\` row(s) on the ${side} side, under its pin of ${pins[side]}; lower the pin`
        );
      }
    }
  }

  return problems;
};

// ── The seed ───────────────────────────────────────────────────────────────────

const cellText = (cell) => {
  return cell.length === 0
    ? '-'
    : cell
        .map(({ name, kind }) => {
          return `${name} [${kind}]`;
        })
        .join(', ');
};

// the concept a row names: its TypeScript name, then its Rust or its C# one, an interface's `I`
// dropped
const conceptOf = (cells) => {
  const side =
    ['typescript', 'rust', 'csharp'].find((one) => {
      return cells[one].length > 0;
    }) ?? 'typescript';
  const [first] = cells[side];

  return classOf(first.kind) === 'type' && /^I[A-Z]/.test(first.name)
    ? first.name.slice(1)
    : first.name;
};

const rowText = (cells, written) => {
  return [conceptOf(cells), ...SIDES.map((side) => cellText(cells[side])), written].join('\t');
};

// each side's kind, `{ side: kind }`, for its name of `names`, `{ side: name }`, the first of its
// list's kinds that renders every other; null where none does
const kindedOf = (names, surfaces) => {
  const sides = Object.keys(names);
  const trial = (index, picked) => {
    if (index === sides.length) {
      return kindsRender(picked) ? picked : null;
    }
    for (const kind of surfaces[sides[index]].get(names[sides[index]]).kinds) {
      const found = trial(index + 1, { ...picked, [sides[index]]: kind });

      if (found !== null) {
        return found;
      }
    }

    return null;
  };

  return trial(0, {});
};

// the cells of `names`, `{ side: name }`, each with the kind that renders the others
const cellsOf = (names, surfaces) => {
  const kinds = kindedOf(names, surfaces) ?? {};

  return Object.fromEntries(
    SIDES.map((side) => {
      return [
        side,
        names[side] === undefined
          ? []
          : [{ name: names[side], kind: kinds[side] ?? surfaces[side].get(names[side]).kinds[0] }],
      ];
    })
  );
};

// whether `rule` gives `names`, `{ side: name }`, their kinds rendering each other
const gives = (rule, names, surfaces) => {
  return kindedOf(names, surfaces) !== null && RULES[rule](cellsOf(names, surfaces));
};

const SEEDED_RULES = Object.freeze([
  ['error', '0007, 0044'],
  ['like', '0007'],
  ['flags', '0007'],
  ['constant', '0007'],
  ['of', '0007, 0044'],
]);

/**
 * The file the lists seed: each key two sides or three share, by name and by the kind's class, a
 * `same` row, a TypeScript `create…` factory beside its type; then each rendering a rule gives, a
 * side's name joining a row or names joining one another, one a side, where the rule gives one
 * alone; then an `alone` row for every other name, each side's count pinned. A Rust module's item,
 * `json::read`, is placed by reading.
 */
export const seedOf = (surfaces) => {
  const left = Object.fromEntries(
    SIDES.map((side) => {
      return [side, new Set(surfaces[side].keys())];
    })
  );
  const kindOf = (side, name) => {
    return surfaces[side].get(name).kinds[0];
  };
  const rows = [];
  const take = (names, written) => {
    const row = { names, factory: null, siblings: [], written };

    for (const [side, name] of Object.entries(names)) {
      left[side].delete(name);
    }
    rows.push(row);

    return row;
  };

  // the shared keys, one name a side
  const groups = new Map();

  for (const side of SIDES) {
    for (const name of left[side]) {
      const kind = kindOf(side, name);
      const key = `${classOf(kind)}:${keyOf(name, kind)}`;
      const group = groups.get(key) ?? {};

      group[side] = [...(group[side] ?? []), name];
      groups.set(key, group);
    }
  }
  for (const group of groups.values()) {
    const sides = Object.keys(group);

    if (
      sides.length > 1 &&
      sides.every((side) => {
        return new Set(group[side].map(arityless)).size === 1;
      })
    ) {
      const row = take(
        Object.fromEntries(
          sides.map((side) => {
            return [side, [...group[side]].sort()[0]];
          })
        ),
        'same'
      );

      for (const side of sides) {
        for (const name of [...group[side]].sort().slice(1)) {
          row.siblings.push({ side, name });
          left[side].delete(name);
        }
      }
    }
  }

  // the renderings: a side's name joining a row the rule gives it, then names joining one another
  const unique = (side, test) => {
    const found = [...left[side]].filter((name) => {
      return !name.includes('::') && test(name);
    });

    return found.length === 1 ? found[0] : null;
  };

  for (const [rule, records] of SEEDED_RULES) {
    for (const row of rows) {
      for (const side of SIDES.filter((one) => row.names[one] === undefined)) {
        const found = unique(side, (name) => {
          return gives(rule, { ...row.names, [side]: name }, surfaces);
        });

        if (found !== null) {
          row.names = { ...row.names, [side]: found };
          row.written = `rendered: ${rule} (${records})`;
          left[side].delete(found);
        }
      }
    }
    for (const side of SIDES) {
      for (const name of [...left[side]]) {
        if (!left[side].has(name) || name.includes('::')) {
          continue;
        }

        const names = { [side]: name };

        for (const other of SIDES.filter((one) => one !== side)) {
          const found = unique(other, (otherName) => {
            return gives(rule, { ...names, [other]: otherName }, surfaces);
          });

          if (found !== null) {
            names[other] = found;
          }
        }
        if (Object.keys(names).length > 1) {
          take(names, `rendered: ${rule} (${records})`);
        }
      }
    }
  }

  // a TypeScript `create…` factory beside its type
  for (const row of rows) {
    const name = row.names.typescript;

    if (name !== undefined && classOf(kindOf('typescript', name)) === 'type') {
      const factory = `create${name.replace(/^I(?=[A-Z])/, '')}`;

      if (left.typescript.has(factory) && kindOf('typescript', factory) === 'function') {
        row.factory = factory;
        left.typescript.delete(factory);
      }
    }
  }

  const texts = rows.map(({ names, factory, siblings, written }) => {
    const cells = cellsOf(names, surfaces);

    for (const { side, name } of siblings) {
      cells[side].push({ name, kind: cells[side][0].kind });
    }
    if (factory !== null) {
      cells.typescript.push({ name: factory, kind: 'function' });
    }

    return rowText(cells, written);
  });
  const alone = Object.fromEntries(SIDES.map((side) => [side, left[side].size]));
  const lonely = SIDES.flatMap((side) => {
    return [...left[side]].map((name) => {
      return rowText(cellsOf({ [side]: name }, surfaces), 'alone');
    });
  });
  const byConcept = (a, b) => {
    return a.toLowerCase().localeCompare(b.toLowerCase()) || a.localeCompare(b);
  };

  return [
    `# alone: typescript ${alone.typescript}, csharp ${alone.csharp}, rust ${alone.rust}`,
    '# concept\ttypescript\tcsharp\trust\tclass',
    ...texts.sort(byConcept),
    ...lonely.sort(byConcept),
    '',
  ].join('\n');
};

if (import.meta.main) {
  const surfaces = surfacesOf();

  if (process.argv.includes('--seed')) {
    writeFileSync(`${ROOT}/${NAMES}`, seedOf(surfaces));
    process.exit(0);
  }

  const read = readOf(ROOT);
  const problems = problemsOf(read(NAMES), surfaces, differencesOf(read(SUPPORT)));

  for (const problem of problems) {
    console.error(problem);
  }
  process.exit(problems.length > 0 ? 1 : 0);
}
