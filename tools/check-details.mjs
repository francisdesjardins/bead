#!/usr/bin/env node
// No exception's message goes into a failure's detail unless the failure stays with the side, its
// report alone (spec 9.0), or the error is the side's own, its words written for the peer: what a
// foreign exception says is the side's, never a peer's to read.
//
//   node tools/check-details.mjs             both implementations' sources
//   node tools/check-details.mjs <file…>     those files alone
//
// The TypeScript side builds a detail by `detail: <error>.message`; the C# side hands
// `<error>.Message` to a failure's constructor, or to one of a gateway's `HttpProblems`. A site not in `ALLOWED` fails, with its file and
// line: a new site is added here by decision, with the test that shows what its detail says.
// Exit 1 on a site that is not allowed, or an allowed one gone.

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

// the sites allowed, by file: how many each holds. Each reports alone (a payload or an envelope
// that does not decode), but router-core.ts's CapacityError, a bound of the side's own, whose words
// the C# side writes as the detail itself, and the gateways': Bead's mapping's own words, of the
// request its client sent, answered to that client PAYLOAD_UNDECODABLE, and of a result it holds
// no form of, `unwritable` and reported, each the mapping's own refusal, `JsonFormError` and
// `JsonFormException`, which nothing else throws; transcoding.json's readings and writings fix
// those words, its failures "a body the gateway's reading refuses" and "a result Bead's proto JSON
// form holds none of" their problems
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

/** The 1-based lines of `text` that put an exception's message in a detail. */
export const sitesOf = (text, path) => {
  const pattern = path.endsWith('.cs') ? CSHARP : TYPESCRIPT;

  return text.split('\n').flatMap((line, index) => (pattern.test(line) ? [index + 1] : []));
};

/** The problems among `files`, each a line of text. */
export const problemsOf = (files, read = (path) => readFileSync(path, 'utf8')) => {
  const problems = [];

  for (const path of files) {
    const lines = sitesOf(read(path), path);
    const allowed = ALLOWED[path] ?? 0;

    if (lines.length > allowed) {
      problems.push(
        `${path}:${lines.slice(allowed === 0 ? 0 : -1).join(',')}: an exception's message goes into a detail, which spec 9.0 keeps to the side's own report; allow the site in tools/check-details.mjs only if it never leaves the side`
      );
    } else if (lines.length < allowed) {
      problems.push(`${path}: ${allowed - lines.length} allowed site(s) gone; lower ALLOWED`);
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
