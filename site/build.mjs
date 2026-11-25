#!/usr/bin/env node
// Builds the page beadproto.dev serves, `dist/index.html`: one document, both
// languages in it, English in the page and French in a template the page swaps in. Each language's
// content is `src/content.<language>.html`, its placeholders filled from the repository: the
// versions and the conformance files' counts, the byte examples and tables of `src/data.mjs`, the
// snippets of `src/snippets/`, excerpts of the sources, and each diagram's SVG, which must be its
// source's render. Its contents are drawn from each section's `data-toc`, in parts where a
// section's `data-part` opens one. The table of the three implementations is drawn from
// `src/data.mjs` and held to `docs/support.md`: each row of its Features and Transports in one part
// of the table or in OFF_THE_PAGE, and each cell's declaration, the stages it says are ahead, the
// union of what its rows' cells say for its sides by the token `ahead: <stage>`, a row of the
// differences of kind open. The table of the transports is drawn from it too, and held to the
// matrix's Transports: each of its rows in one transport or in TRANSPORTS_OFF, and each transport's
// sides those that carry its rows. It writes the not-found page too, `dist/404.html`, its styles
// over the same skin. Node alone, nothing installed, and the same bytes on every machine.
//
//   node build.mjs   writes dist/index.html and dist/404.html
//
// Exit 1 on a placeholder it cannot fill, a diagram whose SVG is not its source's, a section the
// contents cannot take, or a table the matrix does not hold: a row in no list or in two, a title
// the matrix lacks, "ahead" in a cell's own words or naming no open difference, a cell that says
// otherwise than its rows, or a transport's sides other than those that carry it.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  EXAMPLES,
  FAILURES,
  FAILURE_HEADINGS,
  FATES,
  HEADER,
  OFF_THE_PAGE,
  PARTS,
  PART_HEADING,
  SIDES,
  STAGES,
  STATUSES,
  STATUS_HEADINGS,
  TRANSPORTS,
  TRANSPORTS_OFF,
  TRANSPORT_HEADINGS,
  WIRE,
} from './src/data.mjs';
import { tokensOf } from '../implementations/typescript/demo/highlight.ts';
import { FACE_NAMES } from '../implementations/typescript/skin/mascot.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const SRC = join(HERE, 'src');
// penumbra's two sheets, Bead's overrides of them, Bead's skin and Bead's top bar, which the demo
// links too: the page's styles come on top of them, and the not-found page's own; and beside them
// the theme's script, which the demo loads too
const PENUMBRA = join(ROOT, 'implementations', 'typescript', 'devtools', 'penumbra');
// Bead's skin: the mascot, which the demo and the DevTools panel bundle, and the page inlines
const SKIN = join(ROOT, 'implementations', 'typescript', 'skin');
const STACK = [
  'tokens.system.css',
  'tokens.skin.base.css',
  'tokens.system.overrides.css',
  'tokens.skin.css',
  'chrome.css',
].map((name) => {
  return join(PENUMBRA, name);
});
const DIAGRAMS = join(HERE, 'diagrams');
export const OUT = join(HERE, 'dist', 'index.html');
export const NOT_FOUND = join(HERE, 'dist', '404.html');
export const PRIVACY = join(HERE, 'dist', 'privacy', 'index.html');

export const LANGUAGES = ['en', 'fr'];
const ADDRESS = 'https://beadproto.dev/';
const PRIVACY_ADDRESS = `${ADDRESS}privacy/`;
const MANIFEST = join(ROOT, 'implementations', 'typescript', 'devtools', 'chrome', 'manifest.json');
const SOURCE = 'https://github.com/francisdesjardins/bead';
const BLOB = `${SOURCE}/blob/main/`;
const TREE = `${SOURCE}/tree/main/`;

// ── Text ──────────────────────────────────────────────────────────────────────

// a file as the build reads it: its line breaks LF, whatever a checkout gave it
const read = (path) => {
  return readFileSync(path, 'utf8').replaceAll('\r\n', '\n');
};

const escape = (text) => {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
};

const escapeAttribute = (text) => {
  return escape(text).replaceAll('"', '&quot;');
};

const pick = (pair, language) => {
  return pair[LANGUAGES.indexOf(language)];
};

// ── Templates ─────────────────────────────────────────────────────────────────

// a placeholder of a template: `{{name}}`, `{{name a="…" b="…"}}`, or `{{s:key}}`, a string of the page
const PLACEHOLDER = /\{\{([\w-]+(?::\w+)?)((?:\s+\w+="[^"]*")*)\s*\}\}/gu;

// what reads as a placeholder once a template is filled: one no filler took
const LEFT = /\{\{[\w:-]+[^}]*\}\}/gu;

// the attributes of a placeholder, `{{name a="…" b="…"}}`
const attributesOf = (text) => {
  return Object.fromEntries(
    [...text.matchAll(/(\w+)="([^"]*)"/gu)].map(([, key, value]) => {
      return [key, value];
    })
  );
};

// a filler that gives markup: HTML, a sheet, a script or a script's JSON. Its markup goes in as it
// is; every other filler gives text, which is escaped.
const raw = (filler) => {
  return Object.freeze({ raw: filler });
};

// the markup's state at the end of `text`, given its state at the start: whether it is inside a
// tag of the HTML, `<a …>`, and in which quote of an attribute's value
const markupAfter = (text, state) => {
  let { inside, quote } = state;
  for (const character of text) {
    if (!inside) {
      inside = character === '<';
    } else if (quote !== '') {
      quote = character === quote ? '' : quote;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === '>') {
      inside = false;
    }
  }
  return { inside, quote };
};

// ! a template's placeholders filled in one pass, each by the filler of its name, which takes its
// attributes. A filler's text is escaped for where the placeholder stands: as an attribute value
// inside an HTML tag, as text outside one. A raw filler's markup goes in as it is. What a filler
// gives is never read for placeholders. A name with no filler, or a placeholder left once filled,
// is refused.
const fill = (template, fillers) => {
  let state = { inside: false, quote: '' };
  let at = 0;
  const filled = template.replace(PLACEHOLDER, (placeholder, name, rest, offset) => {
    state = markupAfter(template.slice(at, offset), state);
    at = offset + placeholder.length;
    if (!Object.hasOwn(fillers, name)) {
      throw new Error(`build: no placeholder ${placeholder}`);
    }
    const filler = fillers[name];
    const attributes = attributesOf(rest);
    if (typeof filler !== 'function') {
      return filler.raw(attributes);
    }
    const text = filler(attributes);
    return state.inside ? escapeAttribute(text) : escape(text);
  });
  const left = filled.match(LEFT);
  if (left !== null) {
    throw new Error(`build: placeholders left: ${[...new Set(left)].join(', ')}`);
  }
  return filled;
};

// French typography's two spaces that never break a line: the narrow one, U+202F, and the one of
// a word's width, U+00A0
const NARROW = String.fromCodePoint(0x20_2f);
const NO_BREAK = String.fromCodePoint(0xa0);

// a number as each language groups its digits: a comma, or a narrow no-break space
const grouped = (value, language) => {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/gu, language === 'fr' ? NARROW : ',');
};

// French typography over the text of a page, never inside a tag, a code span or a block of code: a
// narrow no-break space before a colon, a semicolon, a question or an exclamation mark, inside
// guillemets and between the groups of a number, and a no-break space where a number meets its
// unit, one of UNITS
const UNITS =
  /(\d) (?=(?:s|ms|µs|min|Kio|Mio|Gio|octets?|bits?|mots?|caractères?|cellules?)(?![\p{L}\d]))/gu;

export const typeset = (html) => {
  const parts = html.split(
    /(<code\b[\s\S]*?<\/code>|<pre\b[\s\S]*?<\/pre>|<svg\b[\s\S]*?<\/svg>|<[^>]+>)/u
  );
  return parts
    .map((part, index) => {
      if (index % 2 === 1) {
        return part;
      }
      return part
        .replace(/[ \xA0]([:;?!»])/gu, `${NARROW}$1`)
        .replace(/«[ \xA0]/gu, `«${NARROW}`)
        .replace(/(\d)[ \xA0](?=\d{3}(?!\d))/gu, `$1${NARROW}`)
        .replace(UNITS, `$1${NO_BREAK}`);
    })
    .join('');
};

// ── Facts read from the repository ────────────────────────────────────────────

const json = (path) => {
  return JSON.parse(read(join(ROOT, path)));
};

const versionOf = (path) => {
  const found = /^\*\*Version: (\d+\.\d+\.\d+)\*\*/mu.exec(read(join(ROOT, path)));
  if (found === null) {
    throw new Error(`build: no version in ${path}`);
  }
  return found[1];
};

// the units of a ledger: a line each, its comments aside
const unitsOf = (path) => {
  return read(join(ROOT, path))
    .split('\n')
    .filter((line) => {
      return line.trim() !== '' && !line.startsWith('#');
    }).length;
};

// the entries of a conformance file's groups: each array of its own, its comment aside
const groupsOf = (file) => {
  return Object.entries(file).filter(([key, value]) => {
    return Array.isArray(value) && !key.startsWith('$');
  });
};

const facts = () => {
  const vectors = groupsOf(json('spec/vectors.json'));
  const codecs = json('spec/codecs.json');
  const durations = json('spec/durations.json');
  const validations = json('spec/validations.json');
  const transcoding = json('spec/transcoding.json');
  return {
    version: json('implementations/typescript/package.json').version,
    spec: versionOf('spec/spec.md'),
    debugging: versionOf('spec/debugging.md'),
    transcoding: versionOf('spec/transcoding.md'),
    units: unitsOf('spec/units.txt'),
    unitsDebugging: unitsOf('spec/debugging-units.txt'),
    unitsTranscoding: unitsOf('spec/transcoding-units.txt'),
    vectors: vectors.reduce((count, [, entries]) => {
      return count + entries.length;
    }, 0),
    vectorGroups: vectors.length,
    conversations: json('spec/conversations.json').conversations.length,
    transportCases: json('spec/transports.json').cases.length,
    payloads: codecs.payloads.length,
    values: codecs.values.length,
    durationPlaces: durations.places.length,
    durationInputs: durations.inputs.length,
    verdicts: validations.verdicts.length,
    details: validations.details.length,
    templates: transcoding.templates.length,
    readings: transcoding.readings.length,
    writings: transcoding.writings.length,
    bindings: transcoding.bindings.length,
    transcodingFailures: transcoding.failures.length,
    events: transcoding.events.length,
    exchanges: transcoding.exchanges.length,
  };
};

// ── Byte examples and tables ──────────────────────────────────────────────────

const bytesOf = (name, language, hero) => {
  const example = EXAMPLES[name];
  if (example === undefined) {
    throw new Error(`build: no byte example ${name}`);
  }
  const cells = example.segments
    .map(([hexes, label, role]) => {
      return `<span class="seg seg-${role}"><span class="hex">${escape(hexes)}</span><span class="lbl">${escape(pick(label, language))}</span></span>`;
    })
    .join('');
  return `<div class="bytes${hero ? ' bytes-hero' : ''}" role="img" aria-label="${escapeAttribute(pick(example.label, language))}">${cells}</div>`;
};

const headerOf = (language) => {
  const rows = HEADER.words
    .map(([name, fields]) => {
      const cells = fields
        .map(([label, width]) => {
          return `<span class="bits" style="--w:${width}"><b>${escape(pick(label, language))}</b><i>${width}</i></span>`;
        })
        .join('');
      return `<div class="word"><code class="word-name">${escape(pick(name, language))}</code><div class="word-bits">${cells}</div></div>`;
    })
    .join('');
  return `<div class="bitmap" role="img" tabindex="0" aria-label="${escapeAttribute(pick(HEADER.label, language))}">${rows}</div>`;
};

const stageOf = (code, language) => {
  return pick(
    STAGES.find(([low, high]) => {
      return low <= code && code <= high;
    })[2],
    language
  );
};

const fateOf = (fates, language) => {
  return [fates]
    .flat()
    .map((fate) => {
      return `<span class="fate fate-${fate}">${escape(pick(FATES[fate], language))}</span>`;
    })
    .join(' ');
};

const failuresOf = (language) => {
  const head = FAILURE_HEADINGS.map((heading) => {
    return `<th scope="col">${escape(pick(heading, language))}</th>`;
  }).join('');
  const body = FAILURES.map(([name, code, fate, when]) => {
    return `<tr><td class="code-num">${code}</td><td><code>${name}</code></td><td><span class="stage">${escape(stageOf(code, language))}</span></td><td>${fateOf(fate, language)}</td><td>${escape(pick(when, language))}</td></tr>`;
  }).join('');
  return `<div class="table-wrap" tabindex="0"><table class="errors"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
};

const statusesOf = (language) => {
  const head = STATUS_HEADINGS.map((heading) => {
    return `<th scope="col">${escape(pick(heading, language))}</th>`;
  }).join('');
  const body = STATUSES.map(([status, what]) => {
    return `<tr><td class="code-num">${status}</td><td>${escape(pick(what, language))}</td></tr>`;
  }).join('');
  return `<div class="table-wrap" tabindex="0"><table class="errors"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
};

const wireOf = (language) => {
  const items = WIRE.map(([path, label]) => {
    const name = path.slice(path.lastIndexOf('/') + 1);
    if (!existsSync(join(ROOT, path))) {
      throw new Error(`build: no ${path}`);
    }
    return `<li><a href="${BLOB}${path}"><code>${escape(name)}</code></a><span class="file-label">${escape(pick(label, language))}</span></li>`;
  }).join('');
  return `<ul class="files">${items}</ul>`;
};

// ── The three implementations, held to the support matrix ─────────────────────

const MATRIX = 'docs/support.md';

// a part ahead, in a side's cell of the matrix: `ahead: <stage>`, the stage the title of a row of
// its differences, of kind open
const TOKEN = /ahead: `([^`]+)`/gu;

// the cells of a row of a Markdown table, a pipe inside a code span none of their bounds
const cellsOf = (line) => {
  const cells = [];
  let cell = '';
  let coded = false;
  for (const character of line.trim().slice(1)) {
    if (character === '`') {
      coded = !coded;
    }
    if (character === '|' && !coded) {
      cells.push(cell.trim());
      cell = '';
    } else {
      cell += character;
    }
  }
  return cells;
};

// the table under a heading of the matrix: its header's cells, and each row's
const tableOf = (lines, heading) => {
  const at = lines.indexOf(heading);
  if (at === -1) {
    throw new Error(`build: ${MATRIX} has no ${heading}`);
  }
  let first = at + 1;
  while (first < lines.length && !lines[first].startsWith('|')) {
    first += 1;
  }
  let end = first;
  while (end < lines.length && lines[end].startsWith('|')) {
    end += 1;
  }
  const [header, , ...rows] = lines.slice(first, end).map(cellsOf);
  return { header, rows };
};

// what a side's cell says is ahead: the stages its tokens name, whether it is nothing but them, and
// whether it says "ahead" in its own words, outside a token and a code span
const aheadIn = (cell) => {
  const stages = [...cell.matchAll(TOKEN)].map(([, stage]) => {
    return stage;
  });
  const rest = cell.replace(TOKEN, '');
  return {
    stages,
    whole: stages.length > 0 && rest.replace(/[\s,;]/gu, '') === '',
    bare: /\bahead\b/iu.test(rest.replace(/`[^`]*`/gu, '')),
  };
};

// each row of the matrix's Features and Transports, by its title, with its heading and what each
// side has ahead in it: the stages its cells name, whether every cell of the side is ahead whole,
// and whether the side carries the row at all; a side's cells are the columns its name heads,
// `Rust` or `Rust client` and `Rust server`
const matrixOf = (refusals) => {
  const lines = read(join(ROOT, MATRIX)).split('\n');
  const differences = tableOf(lines, '## Differences');
  const kind = differences.header.indexOf('Kind');
  const open = new Set(
    differences.rows
      .filter((cells) => {
        return cells[kind] === 'open';
      })
      .map(([title]) => {
        return title;
      })
  );
  const rows = new Map();
  for (const heading of ['## Features', '## Transports']) {
    const { header, rows: cellsOfRows } = tableOf(lines, heading);
    for (const cells of cellsOfRows) {
      const [title] = cells;
      if (rows.has(title)) {
        refusals.push(`${MATRIX} holds two rows “${title}”`);
      }
      const sides = {};
      for (const [side] of SIDES) {
        const states = header
          .map((name, index) => {
            return name === side || name.startsWith(`${side} `)
              ? aheadIn(cells[index] ?? '')
              : null;
          })
          .filter((state) => {
            return state !== null;
          });
        if (states.length === 0) {
          throw new Error(`build: ${MATRIX}'s ${heading} has no column for ${side}`);
        }
        // * a side carries the row where one of its cells is neither ahead whole, nor "not
        // available" or "not tested", nor empty
        const carried = header.some((name, index) => {
          if (name !== side && !name.startsWith(`${side} `)) {
            return false;
          }
          const cell = (cells[index] ?? '').trim();
          return cell !== '' && !aheadIn(cell).whole && !/^not\b/iu.test(cell);
        });
        for (const state of states) {
          if (state.bare) {
            refusals.push(
              `${MATRIX}, “${title}”, ${side}: says ahead in its own words; write ahead: \`<stage>\`, the title of a row of its differences, of kind open`
            );
          }
          for (const stage of state.stages) {
            if (!open.has(stage)) {
              refusals.push(
                `${MATRIX}, “${title}”, ${side}: ahead: \`${stage}\` names no row of its differences of kind open`
              );
            }
          }
        }
        sides[side] = {
          stages: new Set(
            states.flatMap((state) => {
              return state.stages;
            })
          ),
          whole: states.every((state) => {
            return state.whole;
          }),
          carried,
        };
      }
      rows.set(title, { heading, sides });
    }
  }
  return rows;
};

const stateText = (stages, whole) => {
  if (stages.size === 0) {
    return 'none ahead';
  }
  return `${[...stages].sort().join(', ')} ahead, ${whole ? 'whole' : 'in part'}`;
};

// ! the table holds the matrix: every row of Features and Transports in exactly one list, a part's
// or OFF_THE_PAGE, and each cell's declaration what its part's rows say for its sides
const tableRefusals = () => {
  const refusals = [];
  const rows = matrixOf(refusals);
  const listed = new Map();
  const lists = [
    ...PARTS.map((part) => {
      return [`the part “${part.name[0]}”`, part.rows];
    }),
    ['OFF_THE_PAGE', OFF_THE_PAGE],
  ];
  for (const [list, titles] of lists) {
    for (const title of titles) {
      if (!rows.has(title)) {
        refusals.push(`${list} names “${title}”, which ${MATRIX} has no row of`);
      } else if (listed.has(title)) {
        refusals.push(`“${title}” is in ${listed.get(title)} and in ${list}`);
      } else {
        listed.set(title, list);
      }
    }
  }
  for (const title of rows.keys()) {
    if (!listed.has(title)) {
      refusals.push(
        `${MATRIX}'s row “${title}” is in no list of src/data.mjs: a part's rows, or OFF_THE_PAGE`
      );
    }
  }
  const sides = SIDES.map(([side]) => {
    return side;
  });
  for (const part of PARTS) {
    const covered = part.cells.flatMap((cell) => {
      return cell.sides;
    });
    if (covered.join() !== sides.join()) {
      refusals.push(
        `the part “${part.name[0]}” has cells for ${covered.join(', ')}, not ${sides.join(', ')}`
      );
      continue;
    }
    const held = part.rows
      .filter((title) => {
        return rows.has(title);
      })
      .map((title) => {
        return rows.get(title).sides;
      });
    for (const cell of part.cells) {
      for (const side of cell.sides) {
        const stages = new Set(
          held.flatMap((row) => {
            return [...row[side].stages];
          })
        );
        const whole =
          held.length > 0 &&
          held.every((row) => {
            return row[side].whole;
          });
        const said = new Set(cell.ahead);
        const saidWhole = cell.whole === true;
        const same =
          stages.size === said.size &&
          [...stages].every((stage) => {
            return said.has(stage);
          }) &&
          whole === saidWhole;
        if (!same) {
          refusals.push(
            `the part “${part.name[0]}”, ${side}: the matrix says ${stateText(stages, whole)}; the page says ${stateText(said, saidWhole)}`
          );
        }
      }
    }
  }
  return [...refusals, ...transportRefusals(rows)];
};

// ! the table of the transports holds the matrix's Transports: each of its rows in exactly one
// transport's `rows` or in TRANSPORTS_OFF, and each transport's sides those that carry every row it
// stands for, a side carrying a row where one of its cells is neither ahead whole nor "not …"
const transportRefusals = (rows, { transports = TRANSPORTS, off = TRANSPORTS_OFF } = {}) => {
  const refusals = [];
  const listed = new Map();
  const lists = [
    ...transports.map((transport) => {
      return [`the transport “${transport.name[0]}”`, transport.rows];
    }),
    ['TRANSPORTS_OFF', off],
  ];
  for (const [list, titles] of lists) {
    for (const title of titles) {
      if (rows.get(title)?.heading !== '## Transports') {
        refusals.push(`${list} names “${title}”, which ${MATRIX}'s Transports has no row of`);
      } else if (listed.has(title)) {
        refusals.push(`“${title}” is in ${listed.get(title)} and in ${list}`);
      } else {
        listed.set(title, list);
      }
    }
  }
  for (const [title, { heading }] of rows) {
    if (heading === '## Transports' && !listed.has(title)) {
      refusals.push(
        `${MATRIX}'s transport “${title}” is in no list of src/data.mjs: a transport's rows, or TRANSPORTS_OFF`
      );
    }
  }
  for (const transport of transports) {
    const held = transport.rows
      .filter((title) => {
        return rows.has(title);
      })
      .map((title) => {
        return rows.get(title).sides;
      });
    const carried = SIDES.map(([side]) => {
      return side;
    }).filter((side) => {
      return (
        held.length > 0 &&
        held.every((sides) => {
          return sides[side].carried;
        })
      );
    });
    if (carried.join() !== transport.sides.join()) {
      refusals.push(
        `the transport “${transport.name[0]}”: the matrix says ${carried.join(', ') || 'no side'}; the page says ${transport.sides.join(', ') || 'no side'}`
      );
    }
  }
  return refusals;
};

// what the table of the transports says otherwise than the matrix, its lists `transports` and
// `off`, TRANSPORTS and TRANSPORTS_OFF by default
export const transportsRefusals = (options) => {
  const refusals = [];
  const rows = matrixOf(refusals);
  return [...refusals, ...transportRefusals(rows, options)];
};

// the sides of a transport in words: all three, one, or two joined
const sidesText = (sides, language) => {
  if (sides.length === SIDES.length) {
    return pick(['all three', 'les trois'], language);
  }
  return sides.join(pick([' and ', ' et '], language));
};

// the table of the transports: where a call runs, its transport, which leads to the section that
// says more where there is one, and the sides that carry it
const transportsOf = (language, ids) => {
  const head = TRANSPORT_HEADINGS.map((heading) => {
    return `<th scope="col">${escape(pick(heading, language))}</th>`;
  }).join('');
  const body = TRANSPORTS.map((transport) => {
    const name = escape(pick(transport.name, language));
    if (transport.detail !== undefined && !ids.has(transport.detail.slice(1))) {
      throw new Error(
        `build: the transport “${transport.name[0]}” leads to ${transport.detail}, no id`
      );
    }
    const linked =
      transport.detail === undefined ? name : `<a href="${transport.detail}">${name}</a>`;
    return `<tr><td>${escape(pick(transport.where, language))}</td><td>${linked}</td><td>${escape(sidesText(transport.sides, language))}</td></tr>`;
  }).join('');
  return `<div class="table-wrap" tabindex="0"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
};

const implementationsOf = (language) => {
  const head = [
    `<th scope="col"><span class="visually-hidden">${escape(pick(PART_HEADING, language))}</span></th>`,
    ...SIDES.map(([, label]) => {
      return `<th scope="col">${escape(pick(label, language))}</th>`;
    }),
  ].join('');
  const body = PARTS.map((part) => {
    const cells = part.cells
      .map((cell) => {
        const span = cell.sides.length > 1 ? ` colspan="${cell.sides.length}"` : '';
        return `<td${span}>${pick(cell.says, language)}</td>`;
      })
      .join('');
    return `<tr><th scope="row">${escape(pick(part.name, language))}</th>${cells}</tr>`;
  }).join('');
  return `<div class="table-wrap" tabindex="0"><table class="compare"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
};

// ── Code ──────────────────────────────────────────────────────────────────────

// a block of code, coloured by the demo's scanner, which Node runs with its types stripped: each
// token in a span of its kind's class, the text between them as it is
const highlight = (source, language) => {
  return tokensOf(source, language)
    .map(({ kind, text }) => {
      return kind === 'text' ? escape(text) : `<span class="tok-${kind}">${escape(text)}</span>`;
    })
    .join('');
};

const codeBlock = (source, language) => {
  return `<pre class="snippet" tabindex="0"><code class="language-${language}">${highlight(source.replace(/^\n+|\s+$/gu, ''), language)}</code></pre>`;
};

// a snippet of src/snippets/, its language's own or the one both share
const snippetOf = (name, language) => {
  for (const file of [`${name}.${language}.txt`, `${name}.txt`]) {
    const path = join(SRC, 'snippets', file);
    if (existsSync(path)) {
      return read(path);
    }
  }
  throw new Error(`build: no snippet ${name} for ${language}`);
};

// whether a line is the one an excerpt names: one that holds the text, or, for `=text`, one that is
// the text once trimmed
const isLine = (line, text) => {
  return text.startsWith('=') ? line.trim() === text.slice(1) : line.includes(text);
};

// the lines of a source from one that holds `from` to the next that holds `to`, each range after
// the last, an ellipsis between two, the common indentation taken off
const excerptOf = (path, ranges) => {
  const lines = read(join(ROOT, path)).split('\n');
  const kept = [];
  let at = 0;
  for (const [from, to] of ranges) {
    const start = lines.findIndex((line, index) => {
      return index >= at && isLine(line, from);
    });
    const end = lines.findIndex((line, index) => {
      return start !== -1 && index >= start && isLine(line, to);
    });
    if (start === -1 || end === -1) {
      throw new Error(`build: ${path} holds no lines from “${from}” to “${to}”`);
    }
    if (kept.length > 0) {
      kept.push('…');
    }
    kept.push(...lines.slice(start, end + 1));
    at = end + 1;
  }
  const indent = Math.min(
    ...kept
      .filter((line) => {
        return line.trim() !== '' && line !== '…';
      })
      .map((line) => {
        return /^ */u.exec(line)[0].length;
      })
  );
  return kept
    .map((line) => {
      return line === '…' ? line : line.slice(indent);
    })
    .join('\n');
};

// the exposition of spec/metrics.json whose calls end at the edges of the buckets, the lines of
// echo's buckets at the edges, its sum, its count, its result and its start kept, a gap marked
const EXPOSITION = 'a duration falls in every bucket whose bound is it or more';
const FAMILIES = [
  'bead_server_call_duration_seconds',
  'bead_server_call_handled_total',
  'bead_server_call_started_total',
];
const BOUNDS = ['0.0', '1e-05', '5e-05', '0.8', '1.0', '2.0', '100.0', '+Inf'];

const expositionOf = () => {
  const kept = (line) => {
    if (line.startsWith('#')) {
      return FAMILIES.includes(line.split(' ')[2]);
    }
    if (!line.includes('procedure="echo"')) {
      return false;
    }
    if (line.includes('_bucket{')) {
      return BOUNDS.some((bound) => {
        return line.includes(`le="${bound}"`);
      });
    }
    return (
      line.includes('_sum{') ||
      line.includes('_count{') ||
      line.includes('outcome="result"') ||
      line.includes('code="SESSION_REQUIRED"') ||
      line.startsWith('bead_server_call_started_total')
    );
  };
  const lines = json('spec/metrics.json').expositions.find((entry) => {
    return entry.name.startsWith(EXPOSITION);
  }).exposition;
  const excerpt = [];
  for (const line of lines) {
    if (kept(line)) {
      excerpt.push(line);
    } else if (excerpt.length > 0 && excerpt.at(-1) !== '…' && line.includes('procedure="echo"')) {
      excerpt.push('…');
    }
  }
  return excerpt.join('\n');
};

// ── Diagrams ──────────────────────────────────────────────────────────────────

const STAMP = /^<!-- sha256 of its source: ([0-9a-f]{64}) -->\n/u;

// a diagram's SVG, which must be its source's render: its stamp, the hash of its source
const diagramOf = (name, language) => {
  const source = join(DIAGRAMS, language, `${name}.mmd`);
  const svg = join(DIAGRAMS, language, `${name}.svg`);
  if (!existsSync(source) || !existsSync(svg)) {
    throw new Error(`build: no diagram ${language}/${name}, its .mmd and its .svg`);
  }
  const text = read(svg);
  const stamp = STAMP.exec(text);
  const hash = createHash('sha256').update(read(source), 'utf8').digest('hex');
  if (stamp === null || stamp[1] !== hash) {
    throw new Error(`build: ${language}/${name}.svg is not its source’s render: node render.mjs`);
  }
  return `<div class="figure-scroll" tabindex="0">${text.slice(stamp[0].length).trim()}</div>`;
};

// ── Content ───────────────────────────────────────────────────────────────────

// the fillers of the main page's content in `language`, its facts those read from the repository,
// `ids` those its template holds
const contentFillers = (language, { known, ids }) => {
  return {
    bytes: raw((attributes) => {
      return bytesOf(attributes.of, language, attributes.hero === 'true');
    }),
    header: raw(() => {
      return headerOf(language);
    }),
    failures: raw(() => {
      return failuresOf(language);
    }),
    statuses: raw(() => {
      return statusesOf(language);
    }),
    wire: raw(() => {
      return wireOf(language);
    }),
    implementations: raw(() => {
      return implementationsOf(language);
    }),
    transports: raw(() => {
      return transportsOf(language, ids);
    }),
    diagram: raw((attributes) => {
      return diagramOf(attributes.of, language);
    }),
    code: raw((attributes) => {
      return codeBlock(snippetOf(attributes.of, language), attributes.language ?? 'typescript');
    }),
    exposition: raw(() => {
      return codeBlock(expositionOf(), 'plaintext');
    }),
    excerpt: raw((attributes) => {
      const ranges = attributes.lines.split(';;').map((range) => {
        return range.split('->').map((end) => {
          return end.trim();
        });
      });
      const caption = `<figcaption><a href="${escapeAttribute(`${BLOB}${attributes.path}`)}"><code>${escape(attributes.path)}</code></a></figcaption>`;
      return `<figure class="excerpt">${codeBlock(excerptOf(attributes.path, ranges), attributes.language ?? 'typescript')}${caption}</figure>`;
    }),
    blob: (attributes) => {
      return `${BLOB}${attributes.path}`;
    },
    tree: (attributes) => {
      return `${TREE}${attributes.path}`;
    },
    fact: (attributes) => {
      const value = known[attributes.of];
      if (value === undefined) {
        throw new Error(`build: no fact ${attributes.of}`);
      }
      return typeof value === 'number' ? grouped(value, language) : value;
    },
  };
};

// a section the contents name: `<section id="…" class="…" data-toc="…" data-part="…"
// data-bead-face="…">`, its class, its part and the mascot's face optional
const ENTRY =
  /<section id="([\w-]+)"((?: class="[^"]*")?) data-toc="([^"]+)"(?: data-part="([^"]*)")?((?: data-bead-face="[^"]*")?)>/gu;

// ! the table of contents, from each section's id and its `data-toc`, which it then drops: a link
// each, in the page's order, and a part, which a section's `data-part` opens under its name, its
// links listed under that name until a section opens another, or `data-part=""` closes it. A
// `data-toc` or a `data-part` the contents did not take is refused, so no section drops out of them
// unseen.
export const contentsOf = (content) => {
  let items = '';
  let open = false;
  for (const [, id, , label, part] of content.matchAll(ENTRY)) {
    if (part !== undefined) {
      if (open) {
        items += '</ol></li>';
      }
      open = part !== '';
      if (open) {
        items += `<li class="toc-part"><p class="toc-part-title">${part}</p><ol>`;
      }
    }
    items += `<li><a href="#${id}">${label}</a></li>`;
  }
  if (open) {
    items += '</ol></li>';
  }
  const stripped = content.replace(ENTRY, (_entry, id, classes, _label, _part, face) => {
    const named = face.slice(' data-bead-face="'.length, -1);
    if (face !== '' && !FACE_NAMES.includes(named)) {
      throw new Error(`build: section ${id} has the face ${named}, which the mascot has not`);
    }
    return `<section id="${id}"${classes}${face}>`;
  });
  const left = stripped.match(/\sdata-(?:toc|part)=/u);
  if (left !== null) {
    throw new Error(
      'build: a data-toc or a data-part the contents did not take: write <section id="…" class="…" data-toc="…" data-part="…" data-bead-face="…">, its class, its part and its face optional'
    );
  }
  return { items, content: stripped };
};

// the strings of the page outside its content, in each language
const STRINGS = Object.freeze({
  en: {
    title: 'Bead: a binary protocol for calls between a client and a server',
    description:
      'Bead is a binary wire protocol for calls between a client and a server, both ways: a written specification, conformance files every implementation plays, TypeScript and C# at behavioural parity, and a Rust side with its core, its WebSocket and HTTP transports, its MQTT 5 binding, its HTTP/JSON gateway and beadc’s Rust target.',
    skip: 'Skip to the content',
    contents: 'Contents',
    // the section read, which the bar's button names, the contents it opens before it
    reading: 'Contents:',
    language: 'Language',
    home: '#top',
    top: 'Bead, to the top of the page',
    demo: 'Demo',
    other: 'Français',
    otherShort: 'FR',
    otherLabel: 'Lire cette page en français',
    toDark: 'Switch to dark mode',
    toLight: 'Switch to light mode',
  },
  fr: {
    title: 'Bead : un protocole binaire pour les appels entre un client et un serveur',
    description:
      'Bead est un protocole binaire pour les appels entre un client et un serveur, dans les deux sens : une spécification écrite, des fichiers de conformance que chaque implantation joue, TypeScript et C# à parité de comportement, et un côté Rust avec son cœur, ses transports WebSocket et HTTP, sa liaison MQTT 5, sa passerelle HTTP/JSON et la cible Rust de beadc.',
    skip: 'Aller au contenu',
    contents: 'Sommaire',
    reading: `Sommaire${NARROW}:`,
    language: 'Langue',
    home: '#top',
    top: 'Bead, en haut de la page',
    demo: 'Démo',
    other: 'English',
    otherShort: 'EN',
    otherLabel: 'Read this page in English',
    toDark: 'Passer au thème sombre',
    toLight: 'Passer au thème clair',
  },
});

// the privacy policy's strings outside its content, over the page's: its head, and its name, which
// leads to the page
const PRIVACY_STRINGS = Object.freeze({
  en: {
    ...STRINGS.en,
    title: 'Bead DevTools: privacy policy',
    description:
      'What the Bead DevTools extension reads, keeps and sends: it reads the Bead debug records of the page you inspect, keeps them in its panel, and sends nothing out of your browser.',
    home: '/',
    top: 'Bead’s page',
  },
  fr: {
    ...STRINGS.fr,
    title: 'Bead DevTools : politique de confidentialité',
    description:
      'Ce que lit, garde et envoie l’extension Bead DevTools : elle lit les enregistrements de débogage Bead de la page que vous inspectez, les garde dans son panneau, et n’envoie rien hors de votre navigateur.',
    home: '/',
    top: 'La page de Bead',
  },
});

// a page's content in `language`, under the bar and beside its contents; `content` is its template,
// already filled
const pageOf = (language, { strings, content: filled }) => {
  const other = language === 'en' ? 'fr' : 'en';
  const { items, content } = contentsOf(language === 'fr' ? typeset(filled) : filled);
  const chrome = fill(read(join(SRC, 'chrome.html')), {
    ...Object.fromEntries(
      Object.entries(strings).map(([key, text]) => {
        return [
          `s:${key}`,
          () => {
            return text;
          },
        ];
      })
    ),
    other: () => {
      return other;
    },
    // * the language of the page marked among the two its contents' foot offers
    'current-en': raw(() => {
      return language === 'en' ? ' aria-current="true"' : '';
    }),
    'current-fr': raw(() => {
      return language === 'fr' ? ' aria-current="true"' : '';
    }),
    toc: raw(() => {
      return items;
    }),
    content: raw(() => {
      return content;
    }),
  });
  return chrome.trim();
};

// sheets as one, in their order
const sheetsOf = (paths) => {
  return paths
    .map((path) => {
      return read(path).trim();
    })
    .join('\n\n');
};

// the not-found page: Bead's skin and its bar on penumbra's sheets, under its own styles, and no
// script
export const buildNotFound = () => {
  return fill(read(join(SRC, '404.html')), {
    stack: raw(() => {
      return sheetsOf(STACK);
    }),
  });
};

// the main page's content in `language`, its placeholders filled from the repository
const mainContentOf = (language, known) => {
  const template = read(join(SRC, `content.${language}.html`));
  // ! the tables of the three implementations and of the transports are drawn from data alone,
  // where the build holds them
  for (const table of ['{{implementations}}', '{{transports}}']) {
    if (template.split(table).length !== 2) {
      throw new Error(`build: content.${language}.html holds ${table} other than once`);
    }
  }
  const ids = new Set(
    [...template.matchAll(/\sid="([\w-]+)"/gu)].map(([, id]) => {
      return id;
    })
  );
  return fill(template, contentFillers(language, { known, ids }));
};

// one document of both languages in the shell: English in the page, French in a template the page
// swaps in, each language's head and canonical address in the JSON beside the script
const documentOf = ({ address, strings, contents }) => {
  const hasMascot = Object.values(contents).some((content) => {
    return facesOf(content) !== '';
  });
  const heads = Object.fromEntries(
    LANGUAGES.map((language) => {
      return [
        language,
        {
          title: strings[language].title,
          description: strings[language].description,
          canonical: language === 'en' ? address : `${address}?lng=${language}`,
        },
      ];
    })
  );
  const pages = Object.fromEntries(
    LANGUAGES.map((language) => {
      return [
        language,
        pageOf(language, { strings: strings[language], content: contents[language] }),
      ];
    })
  );
  return fill(read(join(SRC, 'shell.html')), {
    style: raw(() => {
      // * Bead's skin and its bar on penumbra's sheets, as the demo has them, then the page's styles
      // over them
      return sheetsOf([...STACK, join(SRC, 'styles.css')]);
    }),
    'head-script': raw(() => {
      return read(join(SRC, 'head.js')).trim();
    }),
    'theme-script': raw(() => {
      // * the theme as the demo keeps it too, one script for both
      return read(join(PENUMBRA, 'theme.js')).trim();
    }),
    'page-script': raw(() => {
      return read(join(SRC, 'page.js')).trim();
    }),
    mascot: raw(() => {
      // * the mascot as the demo and the panel have it, one module, mounted on the page's sections;
      // a document whose sections give it no face has none
      if (!hasMascot) {
        return '';
      }
      return `    <script type="module">\n${read(join(SKIN, 'mascot.js')).trim()}\n\nmountMascot();\n    </script>`;
    }),
    heads: raw(() => {
      return JSON.stringify(heads).replaceAll('<', '\\u003c');
    }),
    title: () => {
      return strings.en.title;
    },
    description: () => {
      return strings.en.description;
    },
    address: () => {
      return address;
    },
    'page-en': raw(() => {
      return pages.en;
    }),
    'page-fr': raw(() => {
      return pages.fr;
    }),
  });
};

// the faces a content gives the mascot, each section's that has one, in the page's order
export const facesOf = (content) => {
  return [...content.matchAll(/<section id="([\w-]+)"[^>]* data-bead-face="([^"]*)"/gu)]
    .map(([, id, face]) => {
      return `${id}=${face}`;
    })
    .join(' ');
};

export const build = () => {
  const refusals = tableRefusals();
  if (refusals.length > 0) {
    throw new Error(
      refusals
        .map((refusal) => {
          return `build: ${refusal}`;
        })
        .join('\n')
    );
  }
  const known = facts();
  const contents = Object.fromEntries(
    LANGUAGES.map((language) => {
      return [language, mainContentOf(language, known)];
    })
  );
  // ! the mascot reads both languages alike: each marks the same sections with the same faces
  const [first, ...others] = LANGUAGES.map((language) => {
    return facesOf(contents[language]);
  });
  if (
    others.some((faces) => {
      return faces !== first;
    })
  ) {
    throw new Error('build: the languages mark their sections with the mascot’s faces apart');
  }
  return documentOf({ address: ADDRESS, strings: STRINGS, contents });
};

// ── The privacy policy ────────────────────────────────────────────────────────

// ! what the DevTools extension's privacy policy states: each key of its manifest, and every address
// its content scripts match. A key added, `permissions` or `host_permissions` say, is a refusal
// until the policy states it and this list takes it.
const STATED_KEYS = Object.freeze([
  'manifest_version',
  'name',
  'version',
  'description',
  'default_locale',
  'minimum_chrome_version',
  'icons',
  'devtools_page',
  'background',
  'content_scripts',
]);
const STATED_MATCHES = Object.freeze(['<all_urls>']);

// what the extension's manifest, its text, declares that the privacy policy does not state
export const policyRefusals = (manifest) => {
  const declared = JSON.parse(manifest);
  const keys = Object.keys(declared).filter((key) => {
    return !STATED_KEYS.includes(key);
  });
  const matches = (declared.content_scripts ?? [])
    .flatMap((script) => {
      return script.matches ?? [];
    })
    .filter((match) => {
      return !STATED_MATCHES.includes(match);
    });
  return [
    ...keys.map((key) => {
      return `the DevTools manifest declares ${key}, which the privacy policy does not state`;
    }),
    ...matches.map((match) => {
      return `the DevTools content scripts match ${match}, which the privacy policy does not state`;
    }),
  ];
};

// the DevTools extension's privacy policy, at /privacy/, in both languages as the page has them
export const buildPrivacy = () => {
  const refusals = policyRefusals(read(MANIFEST));
  if (refusals.length > 0) {
    throw new Error(
      refusals
        .map((refusal) => {
          return `build: ${refusal}`;
        })
        .join('\n')
    );
  }
  return documentOf({
    address: PRIVACY_ADDRESS,
    strings: PRIVACY_STRINGS,
    contents: Object.fromEntries(
      LANGUAGES.map((language) => {
        return [language, fill(read(join(SRC, `privacy.${language}.html`)), {})];
      })
    ),
  });
};

// the diagrams the content names, each of both languages
export const diagramsNamed = () => {
  return LANGUAGES.flatMap((language) => {
    return readdirSync(join(DIAGRAMS, language))
      .filter((file) => {
        return file.endsWith('.mmd');
      })
      .map((file) => {
        return `${language}/${file.slice(0, -'.mmd'.length)}`;
      });
  });
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const page = build();
    const notFound = buildNotFound();
    const privacy = buildPrivacy();
    mkdirSync(dirname(PRIVACY), { recursive: true });
    writeFileSync(OUT, page);
    writeFileSync(NOT_FOUND, notFound);
    writeFileSync(PRIVACY, privacy);
    console.log(`build: dist/index.html, ${grouped(Buffer.byteLength(page), 'en')} bytes`);
    console.log(`build: dist/404.html, ${grouped(Buffer.byteLength(notFound), 'en')} bytes`);
    console.log(
      `build: dist/privacy/index.html, ${grouped(Buffer.byteLength(privacy), 'en')} bytes`
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
