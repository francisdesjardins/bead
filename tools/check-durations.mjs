#!/usr/bin/env node
// Every duration an application gives a side through its surface is a place of
// spec/durations.json, taken by one of its ways (spec 1.4, decision 0014): `tools/durations.tsv`
// names, for each place and way, the member of each side's surface list that takes it, and for
// each member that carries a duration no application gives Bead, why. The lists are those
// `tools/check-names.mjs` reads: `implementations/typescript/surface.txt`, each C# project's
// `PublicAPI.Shipped.txt` with its `PublicAPI.Unshipped.txt` applied, and the Rust side's lists
// under `implementations/rust/crates/bead-house/surfaces/`.
//
//   node tools/check-durations.mjs           the table against the file and the three lists
//   node tools/check-durations.mjs --seed    writes tools/durations.tsv anew from them
//
// ! the seed writes over every row a reading placed: it starts the file, and the file is kept by
// hand after it
//
// A member carries a duration when it takes or gives one: on the C# side a line naming
// `System.TimeSpan`; on the Rust side a line whose type names `Duration`; on the TypeScript side,
// whose durations are `number`, a member or a parameter typed `number` whose name DURATION_WORDS
// matches, or typed by an object that holds one; and on every side a member, a parameter or a
// constant whose type names a carrier, a type being a carrier when a property, a field or a variant
// of it stands on a place row, and an alias of a carrier one too, so that a new owner of a type that
// holds a duration is a row too. A carrier's own members, its equality among them, and what a
// method gives back of a carrier are asked no row.
//
// A row is tab-separated: a place's id and a way's id of the file, then one cell a side; or
// `no place`, its reason, then one cell a side. A cell names one member or several, by commas, as
// surface-lists.mjs reads them, or `-` with its class:
//
//   - differs: <title>   the side lacks the way, where a `differs` of the way excuses its language,
//                        the title that row's of docs/support.md
//   - ahead: <title>     the place or the way is ahead for the side, the title the row of AHEAD
//                        that holds the way, or else its place's owner (spec/check.py)
//   - inside: <reason>   the side takes the way inside its library, where its harness reaches it,
//                        at no member of its surface
//   -                    on a `no place` row, a side with no such member
//
// What it does not reach: a row that names the wrong place, which each harness finds where what it
// builds differs and review where it does not; a TypeScript duration whose name the pattern misses
// and whose twin no other side has. A row's `ahead:` cells are spec/check.py's, which owns AHEAD.
//
// Exit 1 on a place or a way with no row or two; a row whose place or way the file does not hold;
// a cell of `?`, which the seed leaves for a reading; a member a cell names that its list does not
// hold; a `differs:` cell where no `differs` of the file excuses its language from the way, or a
// member where one does; a class whose title is no row of docs/support.md, or an `inside:` with no
// reason; a member that carries a duration on no row; a member on a place row and a `no place` row;
// a `no place` row with no reason or no member; or a side whose list yields no member that carries
// a duration.

import { writeFileSync } from 'node:fs';

import {
  cSharpMembersOf,
  differencesOf,
  listsOf,
  readOf,
  ROOT,
  rustMembersOf,
  SIDES,
  SUPPORT,
  topLevel,
  typeScriptMembersOf,
} from './surface-lists.mjs';

const TABLE = 'tools/durations.tsv';
const FILE = 'spec/durations.json';
const NO_PLACE = 'no place';

// the language a `differs` of the file names, by its side
const LANGUAGES = Object.freeze({ typescript: 'TypeScript', csharp: 'C#', rust: 'Rust' });

// * the words a TypeScript duration's name ends with, its case and its `_` dropped: its durations
// are `number`, so its census is its names'
export const DURATION_WORDS =
  /(?:timeout|heartbeat|delay|wait|pause|interval|duration|leeway|period|keepalive|expiresafter)s?$/;

// ── The members ────────────────────────────────────────────────────────────────

// a member's own name: a parameter's, a property's, a constant's or an alias's
const nameOf = (member) => {
  const parameter = member.id.match(/\(([^()]*)\)$/);

  if (parameter !== null) {
    return parameter[1];
  }

  return member.id.split(/[.:]/).at(-1);
};

const isDurationName = (name) => {
  return DURATION_WORDS.test(name.replace(/_/g, '').toLowerCase());
};

// whether a TypeScript type is a number, through the aliases it names
const isNumeric = (type, aliases, seen = new Set()) => {
  return topLevel(type.replace(/^readonly /, ''), '|').some((part) => {
    if (/^(?:number|-?\d[\d_]*(?:\.\d+)?)$/.test(part)) {
      return true;
    }
    if (aliases.has(part) && !seen.has(part)) {
      seen.add(part);

      return isNumeric(aliases.get(part), aliases, seen);
    }

    return false;
  });
};

// whether a TypeScript type is an object that holds a duration: `{timeout?: number}`
const holdsDuration = (type) => {
  for (const found of type.matchAll(
    /(?:^|[{;,]\s*)(?:readonly )?([A-Za-z_$][\w$]*)\??: ([^;,}]+)/g
  )) {
    if (
      isDurationName(found[1]) &&
      /^(?:number|-?\d[\d_]*)(?: \| undefined)?$/.test(found[2].trim())
    ) {
      return true;
    }
  }

  return false;
};

/** Whether a member of `side` carries a duration, by its side's rule. */
const carriesDuration = (side, member, aliases) => {
  if (side === 'csharp') {
    return /\bSystem\.TimeSpan\b/.test(member.type);
  }
  if (side === 'rust') {
    return /\bDuration\b/.test(member.type);
  }
  if (member.kind === 'return' || member.id.startsWith('[')) {
    return false;
  }

  return (
    (isDurationName(nameOf(member)) && isNumeric(member.type, aliases)) ||
    (member.kind !== 'alias' && holdsDuration(member.type))
  );
};

/**
 * Each side's members, `{ side: Map(id → member) }`, read from its list, `{ typescript: text,
 * csharp: lines, rust: texts }`, each with whether it carries a duration.
 */
export const surfaceOf = (lists) => {
  const read = {
    typescript: typeScriptMembersOf(lists.typescript),
    csharp: cSharpMembersOf(lists.csharp),
    rust: rustMembersOf(lists.rust),
  };

  return Object.fromEntries(
    SIDES.map((side) => {
      const aliases = new Map(
        read[side]
          .filter((member) => {
            return member.kind === 'alias';
          })
          .map((member) => [member.id, member.type])
      );
      const members = new Map();

      for (const member of read[side]) {
        if (!members.has(member.id)) {
          members.set(member.id, { ...member, duration: carriesDuration(side, member, aliases) });
        }
      }

      return [side, members];
    })
  );
};

/** The members of each side's list that carry a duration, `{ side: [id] }`, sorted. */
export const membersOf = (lists) => {
  const surface = surfaceOf(lists);

  return Object.fromEntries(
    SIDES.map((side) => {
      return [
        side,
        [...surface[side].values()]
          .filter((member) => {
            return member.duration;
          })
          .map((member) => {
            return member.id;
          })
          .sort(),
      ];
    })
  );
};

// ── The carriers ───────────────────────────────────────────────────────────────

// a type's name without its type arguments, `Bead.Session<TData>` as `Bead.Session`
const baseOf = (type) => {
  return type.replace(/<.*$/, '');
};

const escaped = (text) => {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
};

// whether a type's text names `carrier` whole: `TransportClientReconnectDelayResolver` names no
// `TransportClientReconnectDelay`, nor `Bead.Outer.Inner` a `Bead.Outer`; and `keyof T`, a name of
// its members, carries none of their values; a Rust path, `crate::router::relay::RelayOptions`, names
// its type
const names = (type, carrier) => {
  const whole = `(?<![\\w$.:])${escaped(carrier)}(?![\\w$]|\\.\\w)`;
  const bare = type
    .replace(/\b(?:[a-z_]\w*::)+/g, '')
    .replace(new RegExp(`\\bkeyof (?:typeof )?${whole}`, 'g'), '');

  return new RegExp(whole).test(bare);
};

/**
 * The carriers of each side, `{ side: Set(type) }`: each type a member of which, a property, a
 * field or a variant, stands on a place row, and each alias of one.
 */
export const carriersOf = (rows, surface) => {
  return Object.fromEntries(
    SIDES.map((side) => {
      const carriers = new Set();

      for (const row of rows) {
        if (row.place === NO_PLACE) {
          continue;
        }
        for (const id of row.cells[side].members) {
          const member = surface[side].get(id);

          if (member?.kind === 'property' && member.owner !== null) {
            carriers.add(baseOf(member.owner));
          }
        }
      }

      // an alias of a carrier carries what it names
      let grown = true;

      while (grown) {
        grown = false;
        for (const member of surface[side].values()) {
          if (
            member.kind === 'alias' &&
            !carriers.has(member.id) &&
            [...carriers].some((carrier) => {
              return names(member.type, carrier);
            })
          ) {
            carriers.add(member.id);
            grown = true;
          }
        }
      }

      return [side, carriers];
    })
  );
};

/**
 * The members each side's rows must hold, `{ side: Map(id → why) }`: each that carries a duration,
 * and each property, parameter or constant whose type names a carrier, but a carrier's own.
 */
export const askedOf = (surface, carriers) => {
  return Object.fromEntries(
    SIDES.map((side) => {
      const asked = new Map();

      for (const member of surface[side].values()) {
        if (member.duration) {
          asked.set(member.id, 'carries a duration');
          continue;
        }
        if (!['property', 'parameter', 'constant'].includes(member.kind)) {
          continue;
        }

        const carrier = [...carriers[side]].find((type) => {
          return (
            names(member.type, type) && (member.owner === null || baseOf(member.owner) !== type)
          );
        });

        if (carrier !== undefined) {
          asked.set(member.id, `is typed by ${carrier}, which holds a place's member`);
        }
      }

      return [side, asked];
    })
  );
};

// ── The table ──────────────────────────────────────────────────────────────────

// a cell: its members, or its class and the title or reason it gives
const cellOf = (text) => {
  const trimmed = text.trim();
  const classed = trimmed.match(/^- (differs|ahead|inside): (.*)$/);

  if (trimmed === '-') {
    return { members: [], class: 'none' };
  }
  if (trimmed === '?' || trimmed === '') {
    return { members: [], class: 'unread' };
  }
  if (classed !== null) {
    return { members: [], class: classed[1], title: classed[2].trim() };
  }

  return { members: topLevel(trimmed, ','), class: 'members' };
};

/** The table's rows, each with its line. */
export const rowsOf = (text) => {
  const rows = [];

  text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .forEach((line, index) => {
      if (line === '' || line.startsWith('#')) {
        return;
      }

      const fields = line.split('\t');

      rows.push({
        line: index + 1,
        fields: fields.length,
        place: fields[0],
        way: fields[1] ?? '',
        cells: {
          typescript: cellOf(fields[2] ?? ''),
          csharp: cellOf(fields[3] ?? ''),
          rust: cellOf(fields[4] ?? ''),
        },
      });
    });

  return rows;
};

// the languages a way's `differs` excuses, by their title
const excusedOf = (way) => {
  return new Map(
    (way.differs ?? []).map(({ language, row }) => {
      return [language, row];
    })
  );
};

/**
 * The problems of `text`, the table, against the file, `{ places }`, each side's members,
 * `surfaceOf`'s, and the titles of the Differences, each a line of text.
 */
export const problemsOf = (text, { durations, surface, differences }) => {
  const rows = rowsOf(text);
  const problems = [];
  const report = (row, message) => {
    problems.push(`${TABLE}:${row.line}: ${message}`);
  };
  const ways = new Map();

  for (const place of durations.places) {
    for (const way of place.ways) {
      ways.set(`${place.id}\t${way.id}`, way);
    }
  }

  const seen = new Map();
  const placed = Object.fromEntries(SIDES.map((side) => [side, new Map()]));
  const unplaced = Object.fromEntries(SIDES.map((side) => [side, new Map()]));

  for (const row of rows) {
    if (row.fields !== 5) {
      report(
        row,
        `${row.fields} field(s); a row holds five, tab-separated: a place, a way and a cell a side, or \`${NO_PLACE}\`, its reason and a cell a side`
      );
      continue;
    }

    const isPlace = row.place !== NO_PLACE;
    const key = `${row.place}\t${row.way}`;
    const way = ways.get(key);

    if (isPlace && seen.has(key)) {
      report(row, `${row.place} by ${row.way} is also line ${seen.get(key)}'s`);
    }
    if (isPlace && way === undefined) {
      report(
        row,
        row.place === '?'
          ? 'a reading places this row: a place and a way of the file, or `no place` and its reason'
          : `${FILE} holds no place ${row.place} taken by a way ${row.way}`
      );
    }
    if (isPlace) {
      seen.set(key, row.line);
    }
    if (!isPlace && row.way.trim() === '') {
      report(row, 'a `no place` row gives its reason');
    }

    const excused = way === undefined ? new Map() : excusedOf(way);
    let named = 0;

    for (const side of SIDES) {
      const cell = row.cells[side];
      const language = LANGUAGES[side];

      if (cell.class === 'unread') {
        report(row, `${side}'s cell is for a reading to place: a member, or \`-\` with its class`);
        continue;
      }
      if (cell.class === 'none' && isPlace) {
        report(
          row,
          `${side}'s cell is \`-\` with no class: \`- differs: <title>\`, \`- ahead: <title>\` or \`- inside: <reason>\``
        );
      }
      if (['differs', 'ahead', 'inside'].includes(cell.class) && !isPlace) {
        report(row, `${side}'s cell on a \`${NO_PLACE}\` row names members or is \`-\``);
      }
      if (['differs', 'ahead'].includes(cell.class) && !differences.has(cell.title)) {
        report(
          row,
          `${side}'s "${cell.title}" is no row of ${SUPPORT}'s Differences; a difference is a row there, with its test`
        );
      }
      if (cell.class === 'inside' && cell.title === '') {
        report(row, `${side}'s \`- inside:\` cell gives its reason`);
      }
      if (isPlace && way !== undefined) {
        if (cell.class === 'differs' && excused.get(language) !== cell.title) {
          report(
            row,
            excused.has(language)
              ? `${side}'s way ${row.way} is excused by "${excused.get(language)}", not "${cell.title}"`
              : `no \`differs\` of ${FILE} excuses ${language} from ${row.place} by ${row.way}`
          );
        }
        if (cell.class !== 'differs' && excused.has(language)) {
          report(
            row,
            `${FILE} excuses ${language} from ${row.place} by ${row.way}, under "${excused.get(language)}": its cell is \`- differs: ${excused.get(language)}\``
          );
        }
      }

      for (const id of cell.members) {
        named++;
        if (!surface[side].has(id)) {
          report(row, `${side}'s list holds no member ${id}`);
        }

        const kept = isPlace ? placed[side] : unplaced[side];
        const other = isPlace ? unplaced[side] : placed[side];

        if (other.has(id)) {
          report(
            row,
            `${side}'s ${id} stands on a place row and a \`${NO_PLACE}\` row (line ${other.get(id)})`
          );
        }
        if (!isPlace && kept.has(id)) {
          report(row, `${side}'s ${id} is also line ${kept.get(id)}'s`);
        }
        if (!kept.has(id)) {
          kept.set(id, row.line);
        }
      }
    }
    if (!isPlace && named === 0) {
      report(row, 'a `no place` row names a member on one side at least');
    }
  }

  for (const [key] of ways) {
    if (!seen.has(key)) {
      const [place, way] = key.split('\t');

      problems.push(`${TABLE}: ${place} by ${way} has no row; give it one, a cell a side`);
    }
  }

  const carriers = carriersOf(rows, surface);
  const asked = askedOf(surface, carriers);

  for (const side of SIDES) {
    const durations = [...surface[side].values()].filter((member) => {
      return member.duration;
    });

    if (durations.length === 0) {
      problems.push(
        `${TABLE}: ${side}'s list yields no member that carries a duration; its reader no longer reads it`
      );
    }
    for (const [id, why] of asked[side]) {
      if (!placed[side].has(id) && !unplaced[side].has(id)) {
        problems.push(
          `${TABLE}: ${side}'s ${id} ${why}, on no row; name it on its place's row, or on a \`${NO_PLACE}\` row with its reason`
        );
      }
    }
  }

  return problems;
};

// ── The seed ───────────────────────────────────────────────────────────────────

// the table's head: what it holds, its classes and its columns
const HEAD = Object.freeze([
  "# The member of each side's surface that takes each place's duration, by each way of",
  '# spec/durations.json, and what carries a duration no application gives: tools/check-durations.mjs',
  "# (decision 0014). A cell holds one member or several, by commas, as its side's list writes it, or",
  '# `-` with its class.',
  '# A class: `- differs: <title>`, the way a `differs` of the file excuses the side from; `- ahead: <title>`,',
  "# the row of spec/check.py's AHEAD that holds the way, or else its place's owner; `- inside: <reason>`, a",
  '# way the side takes inside its library, at no member of its surface. A `no place` row gives its reason.',
  '# place\tway\ttypescript\tcsharp\trust',
]);

// a member's key under the case rules: its owner's last name, an interface's `I` dropped, and its
// own, their case and their `_` dropped
const keyOf = (side, member) => {
  const id = member.id.replace(/<[^<>]*>/g, '');
  const parameter = id.match(/\(([^()]*)\)$/);
  const path = id.replace(/\(.*\)$/, '').split(side === 'rust' ? '::' : '.');
  const name = path.at(-1);
  const owner =
    member.owner === null
      ? ''
      : (side === 'csharp' ? baseOf(member.owner).split('.').at(-1) : baseOf(member.owner)).replace(
          side === 'typescript' ? /^I(?=[A-Z])/ : /^$/,
          ''
        );
  const flat = (text) => {
    return text.replace(/_/g, '').toLowerCase();
  };

  return `${flat(owner)}.${flat(name)}${parameter === null ? '' : `(${flat(parameter[1])})`}`;
};

// the C# members that take a place by its options: its owner's type, `Options` dropped, and its
// member, under the case rules
const placedOf = (place, csharp) => {
  const [owner, member] = place.id.split('.');

  return [...csharp.values()].filter((one) => {
    if (!one.duration || one.owner === null || one.kind !== 'property') {
      return false;
    }

    const [ownerKey, memberKey] = keyOf('csharp', one).split('.');

    return (
      ownerKey.replace(/options$/, '') === owner.toLowerCase() && memberKey === member.toLowerCase()
    );
  });
};

const cellText = (ids) => {
  return ids.length === 0 ? '?' : [...ids].sort().join(', ');
};

/**
 * The table the lists and the file seed: a row for each place and way, a place's `options` way, or
 * its one way, given the C# member its id names and that member's twins on the other sides, each by
 * the case rules; a `- differs:` cell where the file excuses a side; every other cell `?`. Then a
 * row of `?` for each other member that carries a duration, or is typed by a carrier, twins on one
 * row, for a reading to place.
 */
export const seedOf = ({ durations, surface }) => {
  const byKey = Object.fromEntries(
    SIDES.map((side) => {
      const keys = new Map();

      for (const member of surface[side].values()) {
        const key = keyOf(side, member);

        keys.set(key, [...(keys.get(key) ?? []), member.id]);
      }

      return [side, keys];
    })
  );
  const rows = [];
  const taken = Object.fromEntries(SIDES.map((side) => [side, new Set()]));

  for (const place of durations.places) {
    for (const way of place.ways) {
      const excused = excusedOf(way);
      const twins =
        way.id === 'options' || place.ways.length === 1
          ? placedOf(place, surface.csharp).map((member) => {
              return keyOf('csharp', member);
            })
          : [];
      const cells = Object.fromEntries(
        SIDES.map((side) => {
          if (excused.has(LANGUAGES[side])) {
            return [side, `- differs: ${excused.get(LANGUAGES[side])}`];
          }

          const ids = twins.flatMap((key) => {
            return (byKey[side].get(key) ?? []).filter((id) => {
              return surface[side].get(id).duration;
            });
          });

          for (const id of ids) {
            taken[side].add(id);
          }

          return [side, cellText(ids)];
        })
      );

      const written = SIDES.map((side) => {
        return cells[side];
      });

      rows.push([place.id, way.id, ...written].join('\t'));
    }
  }

  const carriers = carriersOf(rowsOf(rows.join('\n')), surface);
  const asked = askedOf(surface, carriers);
  const left = new Map();

  for (const side of SIDES) {
    for (const id of [...asked[side].keys()].sort()) {
      if (taken[side].has(id)) {
        continue;
      }

      const key = keyOf(side, surface[side].get(id));
      const group = left.get(key) ?? { typescript: [], csharp: [], rust: [] };

      group[side].push(id);
      left.set(key, group);
    }
  }

  const unread = [...left.keys()].sort().map((key) => {
    const group = left.get(key);

    return [
      '?',
      '?',
      ...SIDES.map((side) => (group[side].length === 0 ? '-' : cellText(group[side]))),
    ].join('\t');
  });

  return [...HEAD, ...rows, ...unread, ''].join('\n');
};

// ── Running ────────────────────────────────────────────────────────────────────

/** What the gate reads under `root`: the file, each side's members and the Differences. */
export const inputsOf = (root = ROOT) => {
  const read = readOf(root);

  return {
    durations: JSON.parse(read(FILE)),
    surface: surfaceOf(listsOf(root)),
    differences: differencesOf(read(SUPPORT)),
  };
};

if (import.meta.main) {
  const inputs = inputsOf();

  if (process.argv.includes('--seed')) {
    writeFileSync(`${ROOT}/${TABLE}`, seedOf(inputs));
    process.exit(0);
  }

  const problems = problemsOf(readOf(ROOT)(TABLE), inputs);

  for (const problem of problems) {
    console.error(problem);
  }
  process.exit(problems.length > 0 ? 1 : 0);
}
