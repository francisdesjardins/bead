#!/usr/bin/env node
// Builds the page francisdesjardins.ca serves at /bead/, `dist/index.html`: one document, both
// languages in it, English in the page and French in a template the page swaps in. Each language's
// content is `src/content.<language>.html`, its placeholders filled from the repository: the
// versions and the conformance files' counts, the byte examples and tables of `src/data.mjs`, the
// snippets of `src/snippets/`, excerpts of the sources, and each diagram's SVG, which must be its
// source's render. Node alone, nothing installed, and the same bytes on every machine.
//
//   node build.mjs   writes dist/index.html
//
// Exit 1 on a placeholder it cannot fill or a diagram whose SVG is not its source's.

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
  STAGES,
  STATUSES,
  STATUS_HEADINGS,
  WIRE,
} from './src/data.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const SRC = join(HERE, 'src');
const DIAGRAMS = join(HERE, 'diagrams');
export const OUT = join(HERE, 'dist', 'index.html');

export const LANGUAGES = ['en', 'fr'];
const ADDRESS = 'https://francisdesjardins.ca/bead/';
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

// a number as each language groups its digits: a comma, or a no-break space
const grouped = (value, language) => {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/gu, language === 'fr' ? ' ' : ',');
};

// French typography over the text of a page, never inside a tag, a code span or a block of code: a
// no-break space before a colon, a semicolon, a question or an exclamation mark and inside
// guillemets, and between the groups of a number
const typeset = (html) => {
  const parts = html.split(
    /(<code\b[\s\S]*?<\/code>|<pre\b[\s\S]*?<\/pre>|<svg\b[\s\S]*?<\/svg>|<[^>]+>)/u
  );
  return parts
    .map((part, index) => {
      if (index % 2 === 1) {
        return part;
      }
      return part
        .replace(/ ([:;?!»])/gu, ' $1')
        .replace(/« /gu, '« ')
        .replace(/(\d) (?=\d{3}(?!\d))/gu, '$1 ');
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
  return `<div class="bitmap" role="img" aria-label="${escapeAttribute(pick(HEADER.label, language))}">${rows}</div>`;
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
  return `<div class="table-wrap"><table class="errors"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
};

const statusesOf = (language) => {
  const head = STATUS_HEADINGS.map((heading) => {
    return `<th scope="col">${escape(pick(heading, language))}</th>`;
  }).join('');
  const body = STATUSES.map(([status, what]) => {
    return `<tr><td class="code-num">${status}</td><td>${escape(pick(what, language))}</td></tr>`;
  }).join('');
  return `<div class="table-wrap"><table class="errors"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
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

// ── Code ──────────────────────────────────────────────────────────────────────

const KEYWORDS = new Set(
  'as async await break case catch class const continue default else enum export extends false finally for from function if import in instanceof interface let message new null of package repeated return static switch syntax this throw true try type typeof undefined using var void while yield'.split(
    ' '
  )
);

// a block of code, coloured as the page colours it: comments, strings, numbers and keywords, by a
// scanner that knows no grammar and needs none for a few lines of a snippet
const highlight = (source, language) => {
  if (language === 'plaintext') {
    return escape(source);
  }
  const comment = language === 'toml' || language === 'shell' ? '#' : '//';
  const pattern = new RegExp(
    [
      `(${comment === '#' ? '#[^\\n]*' : '\\/\\/[^\\n]*'})`,
      '("(?:[^"\\\\\\n]|\\\\.)*"|\'(?:[^\'\\\\\\n]|\\\\.)*\'|`(?:[^`\\\\]|\\\\.)*`)',
      '(\\b(?:0x[0-9a-fA-F_]+|\\d[\\d_]*(?:\\.\\d+)?(?:e[+-]?\\d+)?)\\b)',
      '([A-Za-z_$][\\w$]*)',
    ].join('|'),
    'gu'
  );
  let out = '';
  let at = 0;
  for (const match of source.matchAll(pattern)) {
    out += escape(source.slice(at, match.index));
    const [text, isComment, isString, isNumber, word] = match;
    if (isComment !== undefined) {
      out += `<span class="tok-comment">${escape(text)}</span>`;
    } else if (isString !== undefined) {
      out += `<span class="tok-string">${escape(text)}</span>`;
    } else if (isNumber !== undefined) {
      out += `<span class="tok-number">${escape(text)}</span>`;
    } else if (word !== undefined && language !== 'json' && KEYWORDS.has(word)) {
      out += `<span class="tok-keyword">${escape(text)}</span>`;
    } else {
      out += escape(text);
    }
    at = match.index + text.length;
  }
  return out + escape(source.slice(at));
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

// the attributes of a placeholder, `{{name a="…" b="…"}}`
const attributesOf = (text) => {
  return Object.fromEntries(
    [...text.matchAll(/(\w+)="([^"]*)"/gu)].map(([, key, value]) => {
      return [key, value];
    })
  );
};

const fill = (template, language, known) => {
  return template.replace(/\{\{(\w+)((?:\s+\w+="[^"]*")*)\s*\}\}/gu, (placeholder, name, rest) => {
    const attributes = attributesOf(rest);
    switch (name) {
      case 'bytes':
        return bytesOf(attributes.of, language, attributes.hero === 'true');
      case 'header':
        return headerOf(language);
      case 'failures':
        return failuresOf(language);
      case 'statuses':
        return statusesOf(language);
      case 'wire':
        return wireOf(language);
      case 'diagram':
        return diagramOf(attributes.of, language);
      case 'code':
        return codeBlock(snippetOf(attributes.of, language), attributes.language ?? 'typescript');
      case 'exposition':
        return codeBlock(expositionOf(), 'plaintext');
      case 'excerpt': {
        const ranges = attributes.lines.split(';;').map((range) => {
          return range.split('->').map((end) => {
            return end.trim();
          });
        });
        const caption = `<figcaption><a href="${BLOB}${attributes.path}"><code>${escape(attributes.path)}</code></a></figcaption>`;
        return `<figure class="excerpt">${codeBlock(excerptOf(attributes.path, ranges), attributes.language ?? 'typescript')}${caption}</figure>`;
      }
      case 'blob':
        return `${BLOB}${attributes.path}`;
      case 'tree':
        return `${TREE}${attributes.path}`;
      case 'fact': {
        const value = known[attributes.of];
        if (value === undefined) {
          throw new Error(`build: no fact ${attributes.of}`);
        }
        return typeof value === 'number' ? grouped(value, language) : value;
      }
      default:
        throw new Error(`build: no placeholder ${placeholder}`);
    }
  });
};

// the table of contents, from each section's id and its `data-toc`, which it then drops
const contentsOf = (content) => {
  const entries = [...content.matchAll(/<section id="([\w-]+)" data-toc="([^"]+)">/gu)];
  const items = entries
    .map(([, id, label]) => {
      return `<li><a href="#${id}">${label}</a></li>`;
    })
    .join('');
  return { items, content: content.replace(/(<section id="[\w-]+") data-toc="[^"]+">/gu, '$1>') };
};

// the strings of the page outside its content, in each language
const STRINGS = Object.freeze({
  en: {
    title: 'Bead: a binary protocol for calls between a client and a server',
    description:
      'Bead is a binary wire protocol for calls between a client and a server, both ways: a written specification, conformance files every implementation plays, TypeScript and C# at behavioural parity, and a Rust side with its core, its WebSocket and HTTP transports and its MQTT 5 binding.',
    skip: 'Skip to the content',
    contents: 'Contents',
    menu: 'Open the contents',
    menuClose: 'Close the contents',
    home: 'Back to francisdesjardins.ca',
    other: 'Français',
    otherShort: 'FR',
    otherLabel: 'Lire cette page en français',
    toDark: 'Switch to dark mode',
    toLight: 'Switch to light mode',
  },
  fr: {
    title: 'Bead : un protocole binaire pour les appels entre un client et un serveur',
    description:
      'Bead est un protocole binaire pour les appels entre un client et un serveur, dans les deux sens : une spécification écrite, des fichiers de conformance que chaque implantation joue, TypeScript et C# à parité de comportement, et un côté Rust avec son cœur, ses transports WebSocket et HTTP et sa liaison MQTT 5.',
    skip: 'Aller au contenu',
    contents: 'Sommaire',
    menu: 'Ouvrir le sommaire',
    menuClose: 'Fermer le sommaire',
    home: 'Retour à francisdesjardins.ca',
    other: 'English',
    otherShort: 'EN',
    otherLabel: 'Read this page in English',
    toDark: 'Passer au thème sombre',
    toLight: 'Passer au thème clair',
  },
});

const pageOf = (language, known) => {
  const strings = STRINGS[language];
  const other = language === 'en' ? 'fr' : 'en';
  const filled = fill(read(join(SRC, `content.${language}.html`)), language, known);
  const { items, content } = contentsOf(language === 'fr' ? typeset(filled) : filled);
  const chrome = read(join(SRC, 'chrome.html'))
    .replaceAll('{{lang}}', language)
    .replaceAll('{{other}}', other)
    .replace(/\{\{s:(\w+)\}\}/gu, (_, key) => {
      return escapeAttribute(strings[key]);
    })
    .replace('{{toc}}', items)
    .replace('{{content}}', content);
  return chrome.trim();
};

export const build = () => {
  const known = facts();
  const heads = Object.fromEntries(
    LANGUAGES.map((language) => {
      return [
        language,
        { title: STRINGS[language].title, description: STRINGS[language].description },
      ];
    })
  );
  const shell = read(join(SRC, 'shell.html'));
  const pages = Object.fromEntries(
    LANGUAGES.map((language) => {
      return [language, pageOf(language, known)];
    })
  );
  const page = shell
    .replace('{{style}}', () => {
      return read(join(SRC, 'styles.css')).trim();
    })
    .replace('{{head-script}}', () => {
      return read(join(SRC, 'head.js')).trim();
    })
    .replace('{{page-script}}', () => {
      return read(join(SRC, 'page.js')).trim();
    })
    .replace('{{heads}}', () => {
      return JSON.stringify(heads).replaceAll('<', '\\u003c');
    })
    .replaceAll('{{title}}', () => {
      return escapeAttribute(STRINGS.en.title);
    })
    .replaceAll('{{description}}', () => {
      return escapeAttribute(STRINGS.en.description);
    })
    .replaceAll('{{address}}', ADDRESS)
    .replace('{{page-en}}', () => {
      return pages.en;
    })
    .replace('{{page-fr}}', () => {
      return pages.fr;
    });
  const left = page.match(/\{\{[\w:-]+[^}]*\}\}/gu);
  if (left !== null) {
    throw new Error(`build: placeholders left: ${[...new Set(left)].join(', ')}`);
  }
  return page;
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
    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, page);
    console.log(`build: dist/index.html, ${grouped(Buffer.byteLength(page), 'en')} bytes`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
