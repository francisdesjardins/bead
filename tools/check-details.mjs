#!/usr/bin/env node
// No exception's message goes into a failure's detail unless the failure stays with the side, its
// report alone (spec 9.0), or the error is the side's own, its words written for the peer, as a
// built-in codec's refusal says its reason in spec 17.2's words: what a foreign exception says is
// the side's, never a peer's to read.
//
//   node tools/check-details.mjs             every implementation's sources
//   node tools/check-details.mjs <file…>     those files alone
//
// The TypeScript side builds a detail by `detail: <error>.message`, or hands `<error>.message` to
// one of a gateway's `problemOf…`; the C# side hands `<error>.Message` to a failure's constructor,
// or to one of a gateway's `HttpProblems`; the Rust side hands an error's `Display`, a refusal's
// `reason()` or an error's `message()` to `Failure::saying`, `Failure::application`, a `detail`
// field or binding, or a helper of its file that hands its parameter on to one. Each site allowed
// carries its marker, `// ! a detail of the side's own words: <why>`, on its line or among the
// comment lines right above it, and its file counts its marked sites in `ALLOWED`: a site unmarked
// fails, with its file and line, and a new site is marked and counted here by decision, with the
// test that shows what its detail says. A site moved, its marker with it, still holds.
//
// A Rust detail spans the lines rustfmt breaks it into, so the scan reads each sink's argument
// whole, by its brackets, and reports the sink's own line. Both of its lists come from the file, as
// the TypeScript and C# patterns key on what every exception carries rather than on a name: the
// sinks, the file's helpers among them, each `fn` or `let`-bound closure one of whose parameters,
// whatever its name, reaches a sink's argument, taken to a fixed point; and the foreign words,
// `.to_string()`, `.reason()`, `.message()`, and every name the file binds an error to,
// interpolated or handed to `format!` after its literal. What it does not reach: a binding not
// named `detail` handed to a sink later, `write!` or `push_str` into a buffer, a macro other than
// `format!`, and a helper of another file; it reads one file at a time, as the other two do.
// Exit 1 on a site that is not allowed, a marker that holds no site, or an allowed one gone.

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

// the marked sites allowed, by file: how many each holds. Each marker says why its site's words
// are the side's own: a payload's codec's reason, in spec 17.2's words, which conversations.json
// checks at a request's PAYLOAD_UNDECODABLE; an envelope that does not decode, reported alone; a
// bound of the side's own; or the gateway's mapping's own refusal, whose words transcoding.json
// fixes. Every implementation's sources are read
export const ALLOWED = Object.freeze({
  'implementations/typescript/src/router/shared/notification.ts': 1,
  'implementations/typescript/src/router/shared/router-core.ts': 2,
  'implementations/typescript/src/router/shared/service-requester.ts': 1,
  'implementations/typescript/src/router/shared/service-resolver.ts': 1,
  'implementations/typescript/src/transcoding/http-gateway.ts': 2,
  'implementations/dotnet/src/Bead.Core/Notification.cs': 1,
  'implementations/dotnet/src/Bead.Core/RouterCore.cs': 2,
  'implementations/dotnet/src/Bead.Core/ServiceManager.Requester.cs': 1,
  'implementations/dotnet/src/Bead.Core/ServiceManager.Resolver.cs': 1,
  'implementations/dotnet/src/Bead.Transcoding.Http/HttpGateway.cs': 2,
  'implementations/rust/crates/bead/src/managers/service.rs': 2,
  'implementations/rust/crates/bead/src/managers/service/notification.rs': 1,
  'implementations/rust/crates/bead/src/router/core.rs': 2,
});

const TYPESCRIPT = /\bdetail\s*(?::|=)\s*[^,;\n]*\.message\b|\bproblemOf\w*\s*\([^\n]*\.message\b/;
const CSHARP =
  /\b(?:Failure|ProtocolFailureOf|OfProtocol|FailureException|HttpProblems\.\w+)\w*\s*\([^\n]*\.Message\b/;
// ! the marker's words are the same on every side, one space after `//`, and its why is never
// empty: Rust's inner doc comment, `//!`, is no marker
const MARKER = /(?<!\/)\/\/ ! a detail of the side's own words:\s*\S/;
const COMMENT = /^\s*\/\//;

// ── Rust ──────────────────────────────────────────────────────────────────────

// the methods whose closure's first parameter is an error
const ERROR_CLOSURES =
  /\b(?:map_err|or_else|unwrap_or_else|inspect_err|map_or_else)\s*\(\s*(?:move\s+)?\|\s*(?:mut\s+)?(\w+)/g;
const ERROR_PATTERNS = /\bErr\(\s*(?:ref\s+)?(?:mut\s+)?(\w+)\s*\)/g;
// a parameter's pattern holds these words, which name no binding
const KEYWORDS = new Set(['mut', 'ref', 'self']);

const blank = (text) => {
  return text.replace(/[^\n]/g, ' ');
};

// `code`, the text with its comments blanked, and `bare`, with its string and character literals'
// contents blanked too: a sink is found and its brackets counted in `bare`, its words read in `code`
const masksOf = (text) => {
  const code = [];
  const bare = [];
  let at = 0;

  const keep = (end, { blanked = false, literal = false } = {}) => {
    const slice = text.slice(at, end);

    code.push(blanked ? blank(slice) : slice);
    bare.push(blanked || literal ? blank(slice) : slice);
    at = end;
  };

  while (at < text.length) {
    const rest = text.slice(at, at + 3);
    const raw = /^b?r(#*)"/.exec(text.slice(at, at + 260));

    if (rest.startsWith('//')) {
      const end = text.indexOf('\n', at);

      keep(end === -1 ? text.length : end, { blanked: true });
    } else if (rest.startsWith('/*')) {
      // * a block comment nests in Rust
      let depth = 0;
      let end = at;

      do {
        if (text.startsWith('/*', end)) {
          depth += 1;
          end += 2;
        } else if (text.startsWith('*/', end)) {
          depth -= 1;
          end += 2;
        } else {
          end += 1;
        }
      } while (depth > 0 && end < text.length);
      keep(end, { blanked: true });
    } else if (raw !== null && !/\w/.test(text[at - 1] ?? '')) {
      const close = text.indexOf(`"${raw[1]}`, at + raw[0].length);
      const end = close === -1 ? text.length : close + 1 + raw[1].length;

      keep(at + raw[0].length);
      keep(end - 1 - raw[1].length, { literal: true });
      keep(end);
    } else if (text[at] === '"') {
      let end = at + 1;

      while (end < text.length && text[end] !== '"') {
        end += text[end] === '\\' ? 2 : 1;
      }
      keep(at + 1);
      keep(end, { literal: true });
      keep(end + 1);
    } else if (text[at] === "'") {
      // a character literal, or a lifetime, which is kept
      const character = /^'(?:\\(?:u\{[^}]*\}|x\w\w|.)|[^\\'\n])'/u.exec(text.slice(at, at + 12));

      if (character === null) {
        keep(at + 1);
      } else {
        keep(at + 1);
        keep(at + character[0].length - 1, { literal: true });
        keep(at + character[0].length);
      }
    } else {
      keep(at + 1);
    }
  }

  return { code: code.join(''), bare: bare.join('') };
};

// where an argument that starts at `start` ends in `bare`: at the bracket that closes it, or, for
// a field's or a binding's, at its comma or semicolon at depth 0
const endOf = (bare, start, { call }) => {
  let depth = 0;

  for (let at = start; at < bare.length; at += 1) {
    const character = bare[at];

    if ('([{'.includes(character)) {
      depth += 1;
    } else if (')]}'.includes(character)) {
      if (depth === 0) {
        return at;
      }
      depth -= 1;
    } else if (!call && depth === 0 && (character === ',' || character === ';')) {
      return at;
    }
  }

  return bare.length;
};

// the pieces of a list at its commas outside any bracket, `<…>` among them, `->` aside
const piecesOf = (list) => {
  const pieces = [];
  let depth = 0;
  let from = 0;

  for (let at = 0; at < list.length; at += 1) {
    const character = list[at];

    if ('([{<'.includes(character)) {
      depth += 1;
    } else if (')]}'.includes(character) || (character === '>' && list[at - 1] !== '-')) {
      depth -= 1;
    } else if (character === ',' && depth === 0) {
      pieces.push(list.slice(from, at));
      from = at + 1;
    }
  }

  return [...pieces, list.slice(from)];
};

// the names a parameter list binds, `self` aside, each pattern's before its type
const parametersOf = (list) => {
  return piecesOf(list).flatMap((piece) => {
    const pattern = piece.split(/:(?!:)/)[0];

    return [...pattern.matchAll(/\b[a-z_]\w*\b/g)]
      .map((name) => {
        return name[0];
      })
      .filter((name) => {
        return !KEYWORDS.has(name) && !name.startsWith('_');
      });
  });
};

// each `fn` and `let`-bound closure of the file: its name, the names its parameters bind, and the
// span of its body
const functionsOf = (bare) => {
  const found = [];

  for (const match of bare.matchAll(/\bfn\s+(\w+)\s*/g)) {
    let at = match.index + match[0].length;

    if (bare[at] === '<') {
      let depth = 0;

      do {
        if (bare[at] === '<') {
          depth += 1;
        } else if (bare[at] === '>' && bare[at - 1] !== '-') {
          depth -= 1;
        }
        at += 1;
      } while (depth > 0 && at < bare.length);
      at = bare.slice(at).search(/\S/) + at;
    }
    if (bare[at] !== '(') {
      continue;
    }

    const close = endOf(bare, at + 1, { call: true });
    let open = close + 1;
    let depth = 0;

    // the body's brace, past the return type and a where clause; a declaration ends at its `;`
    while (open < bare.length && !(depth === 0 && (bare[open] === '{' || bare[open] === ';'))) {
      if ('(['.includes(bare[open])) {
        depth += 1;
      } else if (')]'.includes(bare[open])) {
        depth -= 1;
      }
      open += 1;
    }
    if (bare[open] === '{') {
      found.push({
        name: match[1],
        parameters: parametersOf(bare.slice(at + 1, close)),
        body: [open + 1, endOf(bare, open + 1, { call: true })],
      });
    }
  }

  for (const match of bare.matchAll(
    /\blet\s+(?:mut\s+)?(\w+)\s*(?::[^=;]*)?=\s*(?:move\s+)?\|([^|]*)\|/g
  )) {
    const start = match.index + match[0].length;

    found.push({
      name: match[1],
      parameters: parametersOf(match[2]),
      body: [start, endOf(bare, start, { call: false })],
    });
  }

  return found;
};

// the names the file binds an error to, beside `error` and `source`: a closure's parameter of
// map_err, or_else, unwrap_or_else, inspect_err or map_or_else, and an `Err(…)` pattern's; a name
// that opens with `_` is dropped, never read
const errorNamesOf = (bare) => {
  const names = new Set(['error', 'source']);

  for (const pattern of [ERROR_CLOSURES, ERROR_PATTERNS]) {
    for (const match of bare.matchAll(pattern)) {
      names.add(match[1]);
    }
  }

  return [...names].filter((name) => {
    return !name.startsWith('_');
  });
};

// each sink of the file, `helpers` among them: where it stands, and its argument's span
const sinksOf = (bare, helpers) => {
  const called = [String.raw`\.saying`, String.raw`\bFailure::application`];

  if (helpers.size > 0) {
    called.push(String.raw`(?<!\bfn\s+)\b(?:${[...helpers].join('|')})`);
  }

  const sink = new RegExp(
    String.raw`(?:${called.join('|')})\s*\(|\bdetail\s*:(?!:)|\blet\s+(?:mut\s+)?detail\b[^=;]*=(?!=)`,
    'g'
  );

  return [...bare.matchAll(sink)].map((match) => {
    const start = match.index + match[0].length;
    const call = match[0].endsWith('(');

    return { at: match.index, start, end: endOf(bare, start, { call }) };
  });
};

// the helpers of the file, to a fixed point: each function one of whose parameters reaches a
// sink's argument, a helper's own call among the sinks
const helpersOf = ({ code, bare }) => {
  const functions = functionsOf(bare);
  let helpers = new Set();

  for (;;) {
    const sinks = sinksOf(bare, helpers);
    const next = new Set(
      functions
        .filter(({ parameters, body: [from, to] }) => {
          if (parameters.length === 0) {
            return false;
          }

          const names = parameters.join('|');
          const named = new RegExp(String.raw`\b(?:${names})\b`);
          const interpolated = new RegExp(String.raw`\{(?:${names})(?=[:}])`);

          return sinks.some(({ at, start, end }) => {
            return (
              at >= from &&
              at < to &&
              (named.test(bare.slice(start, end)) || interpolated.test(code.slice(start, end)))
            );
          });
        })
        .map(({ name }) => {
          return name;
        })
    );

    if (next.size === helpers.size) {
      return helpers;
    }
    helpers = next;
  }
};

// whether an argument carries an error's words: its Display, a refusal's reason, an error's
// message, or a name the file binds an error to, interpolated or handed to `format!`
const foreignOf = (names) => {
  const called = /\.(?:to_string|reason|message)\s*\(\s*\)/;
  const interpolated = new RegExp(String.raw`\{(?:${names.join('|')})(?=[:}])`);
  const handed = new RegExp(String.raw`^\s*(?:\w+\s*=\s*)?&?(?:${names.join('|')})\s*$`);

  // * a call is read in code, an interpolation in a literal
  return ({ code, bare }) => {
    if (called.test(bare) || interpolated.test(code)) {
      return true;
    }

    return [...bare.matchAll(/\bformat!\s*\(/g)].some((match) => {
      const start = match.index + match[0].length;
      const [, ...after] = piecesOf(bare.slice(start, endOf(bare, start, { call: true })));

      return after.some((piece) => {
        return handed.test(piece);
      });
    });
  };
};

const rustSitesOf = (text) => {
  const masks = masksOf(text);
  const { code, bare } = masks;
  const foreign = foreignOf(errorNamesOf(bare));
  const lines = new Set();

  for (const { at, start, end } of sinksOf(bare, helpersOf(masks))) {
    if (foreign({ code: code.slice(start, end), bare: bare.slice(start, end) })) {
      lines.add(text.slice(0, at).split('\n').length);
    }
  }

  return [...lines].sort((a, b) => {
    return a - b;
  });
};

// ── Sites ─────────────────────────────────────────────────────────────────────

/** The 1-based lines of `text` that put an exception's message in a detail, a comment's aside. */
export const sitesOf = (text, path) => {
  if (path.endsWith('.rs')) {
    return rustSitesOf(text);
  }

  const pattern = path.endsWith('.cs') ? CSHARP : TYPESCRIPT;

  return text
    .split('\n')
    .flatMap((line, index) => (!COMMENT.test(line) && pattern.test(line) ? [index + 1] : []));
};

/**
 * The 1-based lines of `text`'s sites, each `held` by a marker or `unheld`, and of its markers that
 * hold no site, `idle`. A marker holds the code line it ends, or the first one below its comment
 * lines.
 */
export const markedOf = (text, path) => {
  const lines = text.split('\n');
  const sites = new Set(sitesOf(text, path));
  const held = new Set();
  const idle = [];

  lines.forEach((line, index) => {
    if (!MARKER.test(line)) {
      return;
    }

    let below = index;

    while (below < lines.length && COMMENT.test(lines[below])) {
      below += 1;
    }

    if (sites.has(below + 1)) {
      held.add(below + 1);
    } else {
      idle.push(index + 1);
    }
  });

  return {
    held: [...held].sort((a, b) => a - b),
    unheld: [...sites].filter((line) => !held.has(line)),
    idle,
  };
};

/** The problems among `files`, each a line of text. */
export const problemsOf = (files, read = (path) => readFileSync(path, 'utf8')) => {
  const problems = [];

  for (const path of files) {
    const { held, unheld, idle } = markedOf(read(path), path);
    const allowed = ALLOWED[path] ?? 0;

    if (unheld.length > 0) {
      problems.push(
        `${path}:${unheld.join(',')}: an exception's message goes into a detail, which spec 9.0 keeps to the side's own report; mark the site "// ! a detail of the side's own words: <why>" and count it in tools/check-details.mjs only if it never leaves the side or its words are the side's own`
      );
    }
    if (idle.length > 0) {
      problems.push(
        `${path}:${idle.join(',')}: a marker that holds no site; keep it on the site's line or right above it, or drop it`
      );
    }
    if (held.length > allowed) {
      problems.push(
        `${path}:${held.join(',')}: ${held.length} marked site(s), ${allowed} allowed; count a new one in tools/check-details.mjs only if it never leaves the side or its words are the side's own`
      );
    } else if (held.length < allowed) {
      problems.push(`${path}: ${allowed - held.length} allowed site(s) gone; lower ALLOWED`);
    }
  }

  return problems;
};

if (import.meta.main) {
  const args = process.argv.slice(2);
  // * every side's sources, its tests aside: Rust's module tests sit in `src/<module>/tests.rs`
  // and `src/<module>/tests/`
  const files =
    args.length > 0
      ? args
      : execFileSync('git', ['ls-files', '-z', 'implementations'], { encoding: 'utf8' })
          .split('\0')
          .filter(
            (path) =>
              /\.(ts|cs|rs)$/.test(path) &&
              /\/src\//.test(path) &&
              !/__tests__|\.Tests\/|\/tests\.rs$|\/tests\//.test(path)
          )
          .concat(Object.keys(ALLOWED));
  const problems = problemsOf([...new Set(files)]);

  for (const problem of problems) {
    console.error(problem);
  }
  process.exit(problems.length > 0 ? 1 : 0);
}
