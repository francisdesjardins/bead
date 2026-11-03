// The surface lists each side pins, read for the gates that hold a rule to them
// (`tools/check-names.mjs`, `tools/check-durations.mjs`): the TypeScript side's
// `implementations/typescript/surface.txt`, each C# project's `PublicAPI.Shipped.txt` with its
// `PublicAPI.Unshipped.txt` applied, and the Rust side's lists under
// `implementations/rust/crates/bead-house/surfaces/`; and the titles of `docs/support.md`'s
// Differences, which a row of either gate's table names.
//
// A list's members are read with their owner and their type's text, as the list writes them:
//
//   TypeScript   `IOwner.member`, `IOwner.method(parameter)`, `function(parameter)`, `CONSTANT`,
//                an alias's name and, for an alias of a function's type, `Alias(parameter)`
//   C#           the PublicAPI line's member path, its accessor left out, `Bead.Owner.Member`,
//                `Bead.Owner.Method(parameter)`, a constructor `Bead.Owner.Owner(parameter)`
//   Rust         `Owner::member`, `Owner::method(parameter)`, `Enum::Variant`, an item of a module
//                `module::NAME` or `module::function(parameter)`, an alias by its name
//
// A function or a method is a member for each of its parameters, `method(parameter)`, and one more,
// `method`, for what it gives back. A destructured TypeScript parameter is named by its pattern,
// `createEventStream({clock, heartbeat})`.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const SIDES = Object.freeze(['typescript', 'csharp', 'rust']);

export const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const SUPPORT = 'docs/support.md';
export const TYPESCRIPT = 'implementations/typescript/surface.txt';
export const CSHARP = 'implementations/dotnet/src';
export const RUST = 'implementations/rust/crates/bead-house/surfaces';

// ── Reading ────────────────────────────────────────────────────────────────────

/** A reader of the files under `root`, each read whole, its line endings `\n`. */
export const readOf = (root) => {
  return (path) => {
    return readFileSync(`${root}/${path}`, 'utf8').replace(/\r\n/g, '\n');
  };
};

/** One project's public lines: its Shipped list with its Unshipped applied. */
export const publicLinesOf = (shipped, unshipped = '') => {
  const lines = new Set(
    shipped.split('\n').filter((line) => {
      return line.trim() !== '' && !line.startsWith('#');
    })
  );

  for (const line of unshipped.split('\n')) {
    if (line.startsWith('*REMOVED*')) {
      lines.delete(line.slice('*REMOVED*'.length));
    } else if (line.trim() !== '' && !line.startsWith('#')) {
      lines.add(line);
    }
  }

  return [...lines].map((line) => {
    return line.trimEnd();
  });
};

/**
 * The three lists under `root`, as their text: the TypeScript side's list, every C# project's
 * public lines, and each Rust list.
 */
export const listsOf = (root = ROOT) => {
  const read = readOf(root);
  const csharp = readdirSync(`${root}/${CSHARP}`)
    .sort()
    .filter((project) => {
      return existsSync(`${root}/${CSHARP}/${project}/PublicAPI.Shipped.txt`);
    })
    .flatMap((project) => {
      const unshipped = `${CSHARP}/${project}/PublicAPI.Unshipped.txt`;

      return publicLinesOf(
        read(`${CSHARP}/${project}/PublicAPI.Shipped.txt`),
        existsSync(`${root}/${unshipped}`) ? read(unshipped) : ''
      );
    });
  const rust = readdirSync(`${root}/${RUST}`)
    .filter((file) => {
      return file.endsWith('.txt');
    })
    .sort()
    .map((file) => {
      return read(`${RUST}/${file}`);
    });

  return { typescript: read(TYPESCRIPT), csharp, rust };
};

/** The titles of the rows of `docs/support.md`'s Differences, each its row's first cell. */
export const differencesOf = (text) => {
  const section = text.split(/^## /m).find((part) => {
    return part.startsWith('Differences\n');
  });

  return new Set(
    (section ?? '')
      .split('\n')
      .filter((line) => {
        return line.startsWith('| ') && !/^\| -/.test(line);
      })
      .slice(1)
      .map((line) => {
        return line.split(' | ')[0].slice(2).trim();
      })
  );
};

// ── Text ───────────────────────────────────────────────────────────────────────

/**
 * A text split at its top level, outside brackets, braces, parentheses, angle brackets and quotes,
 * each part trimmed.
 */
export const topLevel = (text, separator) => {
  const parts = [];
  let depth = 0;
  let quote = null;
  let start = 0;

  for (let index = 0; index < text.length; index++) {
    const char = text[index];

    if (quote !== null) {
      if (char === quote && text[index - 1] !== '\\') {
        quote = null;
      }
    } else if (char === "'" || char === '"' || char === '`') {
      quote = char;
    } else if ('([{<'.includes(char)) {
      depth++;
    } else if (')]}'.includes(char) || (char === '>' && !'=-'.includes(text[index - 1]))) {
      depth--;
    } else if (depth === 0 && text.startsWith(separator, index)) {
      parts.push(text.slice(start, index));
      start = index + separator.length;
      index += separator.length - 1;
    }
  }
  parts.push(text.slice(start));

  return parts.map((part) => {
    return part.trim();
  });
};

// the index of the parenthesis that closes the one at `open`
const closingOf = (text, open) => {
  let depth = 0;

  for (let index = open; index < text.length; index++) {
    if (text[index] === '(') {
      depth++;
    } else if (text[index] === ')') {
      depth--;
      if (depth === 0) {
        return index;
      }
    }
  }

  return text.length;
};

// the members of a function: one a parameter, `name(parameter)`, and one for what it gives back
const functionMembersOf = (id, parameters, given, base) => {
  return [
    ...parameters.map(({ name, type }) => {
      return { ...base, id: `${id}(${name})`, kind: 'parameter', type };
    }),
    { ...base, id, kind: 'return', type: given },
  ];
};

// ── TypeScript ─────────────────────────────────────────────────────────────────

// a TypeScript parameter list's parameters: a destructured one named by its pattern, a rest one
// by its name
const typeScriptParametersOf = (text) => {
  if (text.trim() === '') {
    return [];
  }

  return topLevel(text, ',').map((part) => {
    const [written, given = ''] = topLevel(part.replace(/^\.\.\./, ''), ':');
    const [type] = topLevel(given, ' = ');
    const name = topLevel(written, ' = ')[0]
      .replace(/\?$/, '')
      .replace(/\s+/g, ' ')
      .replace(/ = [^,}]*/g, '');

    return { name, type };
  });
};

// a TypeScript signature, `name?<…>(…): …`, as its name, parameters and what it gives back
const typeScriptSignatureOf = (text) => {
  const found = text.match(/^(new |constructor|\[[^\]]+\]|[A-Za-z_$][\w$]*)?\??\s*(<[^(]*?>)?\(/);

  if (found === null) {
    return null;
  }

  const open = found[0].length - 1;
  const close = closingOf(text, open);
  const given = text
    .slice(close + 1)
    .replace(/^:\s*/, '')
    .trim();

  return {
    name: (found[1] ?? '').trim(),
    parameters: typeScriptParametersOf(text.slice(open + 1, close)),
    given,
  };
};

// a TypeScript function's type, `(…) => …`, as its parameters and what it gives back; null for
// any other type
const typeScriptFunctionTypeOf = (text) => {
  const body = text.replace(/^(?:<[^(]*?>)?/, '');

  if (!body.startsWith('(')) {
    return null;
  }

  const close = closingOf(body, 0);
  const rest = body.slice(close + 1).trim();

  if (!rest.startsWith('=>')) {
    return null;
  }

  return {
    parameters: typeScriptParametersOf(body.slice(1, close)),
    given: rest.slice(2).trim(),
  };
};

/**
 * The TypeScript side's members, from its list: each declaration's members under the name it is
 * exported by, an interface listing the members it inherits as its own, so that one declaration
 * is a member of each interface that holds it.
 */
export const typeScriptMembersOf = (text) => {
  const lines = text.split('\n');
  const members = [];
  let owner = null;

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const header = line.match(/^src\/\S+ ([A-Za-z_$][\w$]*)$/);

    if (header !== null) {
      owner = { name: header[1], declaration: null };
      continue;
    }
    if (owner === null) {
      continue;
    }

    const top = line.match(/^ {2}(\S.*)$/);
    const nested = line.match(/^ {4}(\S.*)$/);

    if (top !== null) {
      const declaration = top[1];
      const alias = declaration.match(/^type ([A-Za-z_$][\w$]*)(?:<.*?>)? = (.*)$/);
      const called = declaration.startsWith('const ')
        ? typeScriptSignatureOf(declaration.slice('const '.length))
        : null;
      const constant = declaration.match(/^const ([A-Za-z_$][\w$]*): (.*)$/);

      owner.declaration = declaration.split(' ')[0];
      if (alias !== null) {
        const [, name, right] = alias;
        const typed = typeScriptFunctionTypeOf(right);

        members.push({ id: name, owner: null, kind: 'alias', type: right });
        if (typed !== null) {
          members.push(
            ...typed.parameters.map(({ name: parameter, type }) => {
              return { id: `${name}(${parameter})`, owner: name, kind: 'parameter', type };
            })
          );
        }
      } else if (called !== null && called.name !== '') {
        members.push(
          ...functionMembersOf(called.name, called.parameters, called.given, { owner: null })
        );
      } else if (constant !== null) {
        members.push({ id: constant[1], owner: null, kind: 'constant', type: constant[2] });
      }
      continue;
    }
    if (nested === null || !['interface', 'class'].includes(owner.declaration)) {
      continue;
    }

    const member = nested[1];
    const property = member.match(
      /^(?:readonly )?([A-Za-z_$][\w$]*|\[[^\]]+\]|'[^']*')(\?)?: (.*)$/
    );

    if (property !== null) {
      members.push({
        id: `${owner.name}.${property[1]}`,
        owner: owner.name,
        kind: 'property',
        type: property[3],
      });
      continue;
    }

    const signature = typeScriptSignatureOf(member);

    if (signature !== null) {
      const name = signature.name === '' ? '' : `.${signature.name.replace(/ $/, '')}`;

      members.push(
        ...functionMembersOf(`${owner.name}${name}`, signature.parameters, signature.given, {
          owner: owner.name,
        })
      );
    }
  }

  return members;
};

// ── C# ─────────────────────────────────────────────────────────────────────────

const MODIFIERS = /^~?(?:(?:abstract|static|virtual|override|const|sealed|readonly|new) )*/;

// a C# parameter list's parameters, each by its name: `Type name = default`
const cSharpParametersOf = (text) => {
  if (text.trim() === '') {
    return [];
  }

  return topLevel(text, ',').map((part) => {
    const [written] = topLevel(part, ' = ');
    const words = written.replace(/^(?:this|params|ref|out|in|scoped) /g, '').split(' ');

    return { name: words.at(-1), type: words.slice(0, -1).join(' ') };
  });
};

/**
 * The C# side's members, from the public lines of every project: each member line's path, its
 * owner the longest type of the lines that starts it, an accessor left out, so that a property's
 * `get` and `init` are one member.
 */
export const cSharpMembersOf = (lines) => {
  const bare = lines.map((line) => {
    return line.replace(MODIFIERS, '');
  });
  const types = new Set(
    bare.filter((line) => {
      return /^[A-Z][\w.]*(?:<[^()]*>)?$/.test(line);
    })
  );
  const members = new Map();

  for (const [index, line] of bare.entries()) {
    if (types.has(line)) {
      continue;
    }

    const open = line.search(/[( ]/);
    const head = open === -1 ? line : line.slice(0, open);
    const owner = [...types]
      .filter((type) => {
        return head.startsWith(`${type}.`) || line.startsWith(`${type}.`);
      })
      .sort((a, b) => {
        return b.length - a.length;
      })[0];

    if (owner === undefined) {
      continue;
    }

    const rest = line.slice(owner.length + 1);
    const arrow = topLevel(rest, ' -> ');
    const given = arrow.length > 1 ? arrow.at(-1) : '';
    const signature = arrow[0].replace(/ = [^()]*$/, '');
    const parenthesis = signature.indexOf('(');
    const add = (member) => {
      const known = members.get(member.id);

      if (known === undefined) {
        members.set(member.id, member);
      } else if (member.type !== 'void') {
        known.type = known.type === 'void' ? member.type : known.type;
      }
    };

    if (parenthesis === -1) {
      const name = signature.replace(/\.(?:get|set|init|add|remove)$/, '');

      // a constant, or a static field, is its type's value, never a member an instance holds
      const kind = /^~?(?:const|static readonly) /.test(lines[index]) ? 'constant' : 'property';

      add({ id: `${owner}.${name}`, owner, kind, type: given });
      continue;
    }

    const name = signature.slice(0, parenthesis);
    const close = closingOf(signature, parenthesis);

    for (const member of functionMembersOf(
      `${owner}.${name}`,
      cSharpParametersOf(signature.slice(parenthesis + 1, close)),
      given,
      { owner }
    )) {
      add(member);
    }
  }

  return [...members.values()];
};

// ── Rust ───────────────────────────────────────────────────────────────────────

// a Rust parameter list's parameters, its receiver left out
const rustParametersOf = (text) => {
  if (text.trim() === '') {
    return [];
  }

  return topLevel(text, ',')
    .filter((part) => {
      return !/^(?:&(?:'\w+ )?(?:mut )?)?self$/.test(part) && part !== '';
    })
    .map((part) => {
      const [name, type = ''] = topLevel(part, ': ');

      return { name: name.replace(/^mut /, ''), type };
    });
};

// a Rust function's line, `fn name<…>(…) -> …`, as its name, parameters and what it gives back
const rustSignatureOf = (text) => {
  const found = text.match(/^(?:pub )?(?:const |async |unsafe )*fn (\w+)\s*(<[^(]*?>)?\(/);

  if (found === null) {
    return null;
  }

  const open = found[0].length - 1;
  const close = closingOf(text, open);
  const given = text
    .slice(close + 1)
    .replace(/^\s*->\s*/, '')
    .trim();

  return {
    name: found[1],
    parameters: rustParametersOf(text.slice(open + 1, close)),
    given,
  };
};

/**
 * The Rust side's members, from its lists: each type's fields, methods, associated constants and
 * variants under the type's name, `Owner::member`; each item of a module under its path from the
 * crate, `module::NAME`; each alias under its name.
 */
export const rustMembersOf = (texts) => {
  const members = [];

  for (const text of texts) {
    let module = null;
    let owner = null;

    for (const line of text.split('\n')) {
      if (/^\S/.test(line)) {
        const path = line.trim().replace(/^crate(?:::)?/, '');

        module = path === '' ? '' : `${path}::`;
        owner = null;
        continue;
      }
      if (module === null) {
        continue;
      }

      const top = line.match(/^ {2}(\S.*)$/);
      const nested = line.match(/^ {4}(\S.*)$/);

      if (top !== null) {
        const declaration = top[1];
        const typed = declaration.match(/^(struct|enum|trait) (\w+)/);
        const alias = declaration.match(/^type (\w+)(?:<.*?>)? = (.*)$/);
        const constant = declaration.match(/^(?:const|static) (\w+): (.*)$/);
        const signature = rustSignatureOf(declaration);

        owner = typed === null ? null : typed[2];
        if (alias !== null) {
          members.push({ id: alias[1], owner: null, kind: 'alias', type: alias[2] });
        } else if (constant !== null) {
          members.push({
            id: `${module}${constant[1]}`,
            owner: null,
            kind: 'constant',
            type: constant[2],
          });
        } else if (signature !== null) {
          members.push(
            ...functionMembersOf(
              `${module}${signature.name}`,
              signature.parameters,
              signature.given,
              { owner: null }
            )
          );
        }
        continue;
      }
      if (nested === null || owner === null) {
        continue;
      }

      const member = nested[1];
      const field = member.match(/^pub (\w+): (.*)$/);
      const constant = member.match(/^const ([A-Z][A-Z0-9_]*): (.*)$/);
      const variant = member.match(/^([A-Z]\w*)(?:\s*([({])\s*(.*?)\s*[)}])?$/);
      const signature = rustSignatureOf(member);

      if (field !== null) {
        members.push({ id: `${owner}::${field[1]}`, owner, kind: 'property', type: field[2] });
      } else if (constant !== null) {
        members.push({
          id: `${owner}::${constant[1]}`,
          owner,
          kind: 'constant',
          type: constant[2],
        });
      } else if (signature !== null) {
        members.push(
          ...functionMembersOf(
            `${owner}::${signature.name}`,
            signature.parameters,
            signature.given,
            { owner }
          )
        );
      } else if (variant !== null && !/^(?:derives|implements) /.test(member)) {
        // ! a variant's fields are its type's text, never its name: `Duration(DurationRefusal)`
        // holds a refusal, and `TimedOut(Duration)` a duration
        members.push({
          id: `${owner}::${variant[1]}`,
          owner,
          kind: 'property',
          type: variant[3] ?? '',
        });
      }
    }
  }

  return members;
};
