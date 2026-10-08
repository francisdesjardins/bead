#!/usr/bin/env node
// What each example under examples/ copies or takes from beadc, held to its source (decision
// 0022): an example is written as a consumer writes one, so what it cannot reference it copies, and
// every copy has this gate. For every folder git lists under examples/:
//
// - its name is one `beadc init` takes, a proto package's part;
// - `beadc.sh` and `beadc.ps1` are what `beadc wrapper` prints, byte for byte;
// - its `buf.yaml` is the one `beadc init` writes, byte for byte, and each line init writes to
//   `.gitignore` and `.gitattributes` is among the example's;
// - where it has a `dotnet/`, its `global.json`, `nuget.config` and `.editorconfig` are the C#
//   side's, byte for byte: none has an include, and the tools that read them walk up from the
//   project;
// - where it has a `typescript/`, its `.oxfmtrc.json`'s options are the TypeScript side's, its
//   `ignorePatterns` and `$schema` aside, oxfmt having no `extends`; and each descriptor its
//   `package.json` shares by name with the side's is the side's, `typescript` read against the
//   side's `typescript-7` alias.
//
//   node tools/check-examples.mjs
//
// From the repository's root, once builder/ is installed: beadc runs on Node from builder/src.
// Exit 1 on a problem, one a line, naming its file and what differs.

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ── Rules ─────────────────────────────────────────────────────────────────────

// the name `beadc init` takes: a proto package's part
const NAME = /^[a-z][a-z0-9_]*$/;

export const WRAPPERS = ['beadc.sh', 'beadc.ps1'];

// what an example's C# half copies from implementations/dotnet, byte for byte
export const DOTNET_COPIES = ['global.json', 'nuget.config', '.editorconfig'];

// the lines init writes to a project's git files, each among the example's
export const GIT_FILES = ['.gitignore', '.gitattributes'];

// oxfmt's keys an example's copy keeps its own
const OWN_OPTIONS = new Set(['$schema', 'ignorePatterns']);

// the side's descriptor of `typescript`, under the alias it keeps beside its own
const ALIASES = new Map([['typescript', 'typescript-7']]);

// ── Texts ─────────────────────────────────────────────────────────────────────

// JSON with comments and trailing commas, as oxfmt's and TypeScript's configurations are written,
// read as JSON: each comment and each comma before a closing bracket left out, strings kept whole
export const parseJsonc = (text) => {
  let json = '';
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (char === '"') {
      let end = index + 1;
      while (end < text.length && text[end] !== '"') {
        end += text[end] === '\\' ? 2 : 1;
      }
      json += text.slice(index, end + 1);
      index = end + 1;
    } else if (text.startsWith('//', index)) {
      const end = text.indexOf('\n', index);
      index = end === -1 ? text.length : end;
    } else if (text.startsWith('/*', index)) {
      const end = text.indexOf('*/', index + 2);
      index = end === -1 ? text.length : end + 2;
    } else if (
      char === ',' &&
      /^\s*(?:\/\/[^\n]*\n\s*|\/\*[\s\S]*?\*\/\s*)*[}\]]/.test(text.slice(index + 1))
    ) {
      index += 1;
    } else {
      json += char;
      index += 1;
    }
  }
  return JSON.parse(json);
};

// the lines of `text`, each trimmed, the empty ones left out
const linesOf = (text) => {
  return text
    .split('\n')
    .map((line) => {
      return line.trim();
    })
    .filter((line) => {
      return line !== '';
    });
};

// ── Comparisons ───────────────────────────────────────────────────────────────

// the lines of `wanted` that `text` does not hold, a missing file holding none
export const missingLines = (wanted, text) => {
  const held = new Set(linesOf(text ?? ''));
  return linesOf(wanted).filter((line) => {
    return !held.has(line);
  });
};

// how an example's oxfmt options differ from the side's, its own keys aside: a key at another
// value, a key the side has and the example lacks, and one the example adds
export const optionDifferences = (example, side) => {
  const keys = new Set([...Object.keys(side), ...Object.keys(example)]);
  return [...keys]
    .filter((key) => {
      return !OWN_OPTIONS.has(key);
    })
    .flatMap((key) => {
      const [mine, theirs] = [example[key], side[key]];
      if (JSON.stringify(mine) === JSON.stringify(theirs)) {
        return [];
      }
      if (mine === undefined) {
        return [`"${key}" missing, the side's ${JSON.stringify(theirs)}`];
      }
      if (theirs === undefined) {
        return [`"${key}" ${JSON.stringify(mine)}, an option the side does not set`];
      }
      return [`"${key}" ${JSON.stringify(mine)}, the side's ${JSON.stringify(theirs)}`];
    });
};

// every descriptor of a package.json, its dependencies and its devDependencies alike
const descriptorsOf = (manifest) => {
  return new Map(Object.entries({ ...manifest.dependencies, ...manifest.devDependencies }));
};

// how an example's descriptors differ from the side's, for each name both hold; the side's alias
// `npm:<name>@<range>` read as `<range>`
export const descriptorDifferences = (example, side) => {
  const sides = descriptorsOf(side);
  return [...descriptorsOf(example)].flatMap(([name, range]) => {
    const alias = ALIASES.get(name);
    const theirs = sides.get(name) ?? (alias === undefined ? undefined : sides.get(alias));
    if (theirs === undefined) {
      return [];
    }
    const stated = theirs.startsWith(`npm:${name}@`) ? theirs.slice(`npm:${name}@`.length) : theirs;
    return stated === range ? [] : [`${name} ${range}, the side's ${stated}`];
  });
};

// ── Judge ─────────────────────────────────────────────────────────────────────

// the problems of one example, `folder` its path from the root and `paths` its files' paths from
// it: `read(path)` gives the text of one of its files, by its path from the folder, or undefined;
// `expected` holds what beadc prints and writes (`wrappers`, `init`: maps of a file's name to its
// text) and what the sides hold (`dotnet`: a map of a copy's name to its text; `oxfmt` and
// `packageJson`, the TypeScript side's texts)
export const judgeExample = ({ folder, paths, read, expected }) => {
  const problems = [];
  const name = folder.split('/').at(-1);
  const problem = (path, what) => {
    problems.push(`${folder}/${path}: ${what}`);
  };
  const has = (half) => {
    return paths.some((path) => {
      return path.startsWith(`${half}/`);
    });
  };
  if (!NAME.test(name)) {
    problems.push(
      `${folder}: ${name} is no name beadc init takes, a lower-case letter, then lower-case letters, digits and _`
    );
  }
  for (const wrapper of WRAPPERS) {
    if (read(wrapper) !== expected.wrappers.get(wrapper)) {
      problem(wrapper, `not what beadc wrapper ${wrapper} prints`);
    }
  }
  if (read('buf.yaml') !== expected.init.get('buf.yaml')) {
    problem('buf.yaml', 'not the buf.yaml beadc init writes');
  }
  for (const file of GIT_FILES) {
    for (const line of missingLines(expected.init.get(file) ?? '', read(file))) {
      problem(file, `no line ${line}, which beadc init writes`);
    }
  }
  if (has('dotnet')) {
    for (const copy of DOTNET_COPIES) {
      if (read(`dotnet/${copy}`) !== expected.dotnet.get(copy)) {
        problem(`dotnet/${copy}`, `not implementations/dotnet/${copy}, byte for byte`);
      }
    }
  }
  if (has('typescript')) {
    const oxfmt = read('typescript/.oxfmtrc.json');
    const manifest = read('typescript/package.json');
    if (oxfmt === undefined) {
      problem('typescript/.oxfmtrc.json', 'missing: oxfmt would format the half by its defaults');
    } else {
      for (const difference of optionDifferences(parseJsonc(oxfmt), parseJsonc(expected.oxfmt))) {
        problem(
          'typescript/.oxfmtrc.json',
          `${difference} (implementations/typescript/.oxfmtrc.json)`
        );
      }
    }
    if (manifest !== undefined) {
      for (const difference of descriptorDifferences(
        JSON.parse(manifest),
        JSON.parse(expected.packageJson)
      )) {
        problem(
          'typescript/package.json',
          `${difference} (implementations/typescript/package.json)`
        );
      }
    }
  }
  return problems;
};

// ── Main ──────────────────────────────────────────────────────────────────────

const CLI = 'builder/src/cli.ts';

// what beadc prints for `args`, run on Node from builder/src in `cwd`
const beadc = (root, args, cwd = root) => {
  const run = spawnSync(process.execPath, [join(root, CLI), ...args], { cwd, encoding: 'utf8' });
  if (run.status !== 0) {
    throw new Error(`beadc ${args.join(' ')}: exit ${run.status}\n${run.stderr}`);
  }
  return run.stdout;
};

// the examples' folders, from what git lists under examples/, tracked or not yet, ignored left out
export const foldersOf = (paths) => {
  return [
    ...new Set(
      paths
        .map((path) => {
          return path.split('/');
        })
        .filter((parts) => {
          return parts[0] === 'examples' && parts.length > 2;
        })
        .map((parts) => {
          return `examples/${parts[1]}`;
        })
    ),
  ].sort();
};

// the problems of every example of the tree at `root`
export const checkExamples = (root) => {
  const listed = execFileSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', 'examples'],
    {
      cwd: root,
      encoding: 'utf8',
    }
  )
    .split('\0')
    .filter((path) => {
      return path !== '';
    });
  const readAt = (path) => {
    const absolute = join(root, path);
    return existsSync(absolute) ? readFileSync(absolute, 'utf8') : undefined;
  };
  const folders = foldersOf(listed);
  const wrappers = new Map(
    WRAPPERS.map((wrapper) => {
      return [wrapper, beadc(root, ['wrapper', wrapper])];
    })
  );
  const dotnet = new Map(
    DOTNET_COPIES.map((copy) => {
      return [copy, readAt(`implementations/dotnet/${copy}`)];
    })
  );
  const problems = folders.flatMap((folder) => {
    const name = folder.split('/').at(-1);
    // init writes into the folder it runs in: a fresh one, removed after
    const scratch = mkdtempSync(join(tmpdir(), 'bead-examples-'));
    let init;
    try {
      if (NAME.test(name)) {
        beadc(root, ['init', name], scratch);
      }
      init = new Map(
        ['buf.yaml', ...GIT_FILES].map((file) => {
          const path = join(scratch, file);
          return [file, existsSync(path) ? readFileSync(path, 'utf8') : undefined];
        })
      );
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
    return judgeExample({
      folder,
      paths: listed
        .filter((path) => {
          return path.startsWith(`${folder}/`);
        })
        .map((path) => {
          return path.slice(folder.length + 1);
        }),
      read: (path) => {
        return readAt(`${folder}/${path}`);
      },
      expected: {
        wrappers,
        init,
        dotnet,
        oxfmt: readAt('implementations/typescript/.oxfmtrc.json'),
        packageJson: readAt('implementations/typescript/package.json'),
      },
    });
  });
  return { folders, problems };
};

if (import.meta.main) {
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  const { folders, problems } = checkExamples(root);
  for (const problem of problems) {
    console.error(`examples: ${problem}`);
  }
  if (problems.length > 0) {
    console.error(`examples: ${problems.length} problem(s) in ${folders.join(', ')}`);
    process.exit(1);
  }
  console.log(
    `examples: ${folders.length === 0 ? 'none' : folders.join(', ')}, each held to its source`
  );
}
