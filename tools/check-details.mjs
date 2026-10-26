#!/usr/bin/env node
// No exception's message goes into a failure's detail unless the failure stays with the side, its
// report alone (spec 9.0), or the error is the side's own, its words written for the peer: what a
// foreign exception says is the side's, never a peer's to read.
//
//   node tools/check-details.mjs             both implementations' sources
//   node tools/check-details.mjs <file…>     those files alone
//
// The TypeScript side builds a detail by `detail: <error>.message`; the C# side hands
// `<error>.Message` to a failure's constructor, or to one of a gateway's `HttpProblems`. Each site
// allowed carries its marker, `// ! a detail of the side's own words: <why>`, on its line or among
// the comment lines right above it, and its file counts its marked sites in `ALLOWED`: a site
// unmarked fails, with its file and line, and a new site is marked and counted here by decision,
// with the test that shows what its detail says. A site moved, its marker with it, still holds.
// Exit 1 on a site that is not allowed, a marker that holds no site, or an allowed one gone.

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

// the marked sites allowed, by file: how many each holds. Each marker says why its site's words
// are the side's own: a payload or an envelope that does not decode, reported alone; a bound of the
// side's own; or the gateway's mapping's own refusal, whose words transcoding.json fixes
export const ALLOWED = Object.freeze({
  'implementations/typescript/src/router/shared/notification.ts': 1,
  'implementations/typescript/src/router/shared/router-core.ts': 2,
  'implementations/typescript/src/router/shared/service-requester.ts': 1,
  'implementations/typescript/src/transcoding/http-gateway.ts': 2,
  'implementations/dotnet/src/Bead.Core/Notification.cs': 1,
  'implementations/dotnet/src/Bead.Core/RouterCore.cs': 2,
  'implementations/dotnet/src/Bead.Core/ServiceManager.Requester.cs': 1,
  'implementations/dotnet/src/Bead.Transcoding.Http/HttpGateway.cs': 2,
});

const TYPESCRIPT = /\bdetail\s*(?::|=)\s*[^,;\n]*\.message\b/;
const CSHARP =
  /\b(?:Failure|ProtocolFailureOf|OfProtocol|FailureException|HttpProblems\.\w+)\w*\s*\([^\n]*\.Message\b/;
// ! the marker's words are the same on both sides, and its why is never empty
const MARKER = /\/\/\s*! a detail of the side's own words:\s*\S/;
const COMMENT = /^\s*\/\//;

/** The 1-based lines of `text` that put an exception's message in a detail, a comment's aside. */
export const sitesOf = (text, path) => {
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
        `${path}:${unheld.join(',')}: an exception's message goes into a detail, which spec 9.0 keeps to the side's own report; mark the site "// ! a detail of the side's own words: <why>" and count it in tools/check-details.mjs only if it never leaves the side`
      );
    }
    if (idle.length > 0) {
      problems.push(
        `${path}:${idle.join(',')}: a marker that holds no site; keep it on the site's line or right above it, or drop it`
      );
    }
    if (held.length > allowed) {
      problems.push(
        `${path}:${held.join(',')}: ${held.length} marked site(s), ${allowed} allowed; count a new one in tools/check-details.mjs only if it never leaves the side`
      );
    } else if (held.length < allowed) {
      problems.push(`${path}: ${allowed - held.length} allowed site(s) gone; lower ALLOWED`);
    }
  }

  return problems;
};

if (import.meta.main) {
  const args = process.argv.slice(2);
  const files =
    args.length > 0
      ? args
      : execFileSync('git', ['ls-files', '-z', 'implementations'], { encoding: 'utf8' })
          .split('\0')
          .filter(
            (path) =>
              /\.(ts|cs)$/.test(path) && /\/src\//.test(path) && !/__tests__|\.Tests\//.test(path)
          )
          .concat(Object.keys(ALLOWED));
  const problems = problemsOf([...new Set(files)]);

  for (const problem of problems) {
    console.error(problem);
  }
  process.exit(problems.length > 0 ? 1 : 0);
}
