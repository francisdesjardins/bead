#!/usr/bin/env node
// A count of bytes that a report, an error or a refusal writes reads "1 byte" at 1 and "N bytes"
// otherwise, on every side, through the side's helper: `byteCountOf` on the TypeScript side,
// `FailureException.ByteCountOf` on the C# side and `failure::byte_count_of` on the Rust side. So
// no side's sources write a count right before the word `bytes` themselves: a TypeScript
// `${…} bytes`, or a C# or Rust `{…} bytes` inside a string literal. A count that can never be 1,
// a constant above it, stays as it is, named in ALLOWED by its file and the expression it
// interpolates; so does each helper's own body.
//
//   node tools/check-byte-counts.mjs           every implementation's sources
//   node tools/check-byte-counts.mjs <file…>   those files alone
//
// It reads one line at a time and leaves comment lines. What it does not reach: a count and its
// word split across lines or literals, a count joined to its word by concatenation, and a word other
// than `bytes`. What another generator writes says `@generated` in its first lines and is left,
// protovalidate's words among them; the tests, the DevTools extension and the demo are no sources
// it reads.
//
// Exit 1 on a count before `bytes` that ALLOWED does not name, or on an allowed one gone.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// the counts that stay before `bytes`, by file: each a constant above 1, or the helper's own body
export const ALLOWED = Object.freeze({
  // a session token's 16 bytes, a failure's record, a header's bound, an envelope's prefix
  'implementations/typescript/src/router/server/session-manager.ts': [
    'String(SESSION_TOKEN_BYTES)',
  ],
  'implementations/typescript/src/router/shared/envelope.ts': ['String(RECORD_BYTES)'],
  'implementations/typescript/src/router/shared/header.ts': [
    'String(MAXIMUM_HEADER_BYTES)',
    'String(PREFIX_BYTES)',
    'String(SESSION_TOKEN_BYTES)',
  ],
  'implementations/typescript/src/router/shared/identifiers.ts': ['String(SESSION_TOKEN_BYTES)'],
  // a JWT's bound in a header
  'implementations/typescript/src/transcoding/http-gateway.ts': ['String(JWT_BYTES)'],
  'implementations/dotnet/src/Bead.Core/EnvelopeCodec.cs': ['RecordBytes'],
  'implementations/dotnet/src/Bead.Core/EnvelopeCodec.Header.cs': [
    'MaximumHeaderBytes',
    'PrefixBytes',
    'SessionToken.Bytes',
  ],
  // the helper itself
  'implementations/dotnet/src/Bead.Core/FailureException.cs': ['count'],
  'implementations/dotnet/src/Bead.Core/SessionToken.cs': ['Bytes'],
  'implementations/dotnet/src/Bead.Transcoding.Http/HttpGateway.cs': ['JwtBytes'],
  'implementations/rust/crates/bead/src/envelope.rs': [
    'MAXIMUM_HEADER_BYTES',
    'PREFIX_BYTES',
    'RECORD_BYTES',
    'SESSION_TOKEN_BYTES',
  ],
  // the helper itself
  'implementations/rust/crates/bead/src/failure.rs': ['count'],
  'implementations/rust/crates/bead/src/gateway/host.rs': ['JWT_BYTES'],
  // a WebSocket handshake's head, read by the MQTT adapter
  'implementations/rust/crates/bead/src/mqtt/websocket.rs': ['MAXIMUM_HEAD_BYTES'],
});

// ── Reading ───────────────────────────────────────────────────────────────────

const COMMENT = /^\s*(?:\/\/|\/\*|\*)/;
const GENERATED = /@generated\b/;
// * a TypeScript template's `${…}`, then C#'s and Rust's `{…}`, Rust's positional `{}` among them,
// read only inside a string, as C#'s empty property pattern, `is { } bytes`, never stands
const TYPESCRIPT = /\$\{([^{}]+)\}\s*bytes\b/g;
const BRACED = /\{([^{}]*)\}\s*bytes\b/g;

/** Whether `index` of `line` stands inside a string: an odd count of unescaped `"` before it. */
const isQuoted = (line, index) => {
  return (line.slice(0, index).match(/(?<!\\)"/g) ?? []).length % 2 === 1;
};

/** Each count `text` writes right before `bytes`: its line and the expression it interpolates. */
export const countsOf = (text, path) => {
  if (GENERATED.test(text.split('\n', 5).join('\n'))) {
    return [];
  }

  const counts = [];

  text.split('\n').forEach((line, index) => {
    if (COMMENT.test(line)) {
      return;
    }

    const pattern = path.endsWith('.ts') ? TYPESCRIPT : BRACED;

    for (const match of line.matchAll(pattern)) {
      if (path.endsWith('.ts') || isQuoted(line, match.index)) {
        counts.push({ line: index + 1, expression: match[1].trim() });
      }
    }
  });

  return counts;
};

// ── Checking ──────────────────────────────────────────────────────────────────

/** What fails among `files`, read by `read`: each count not allowed, then each allowed one gone. */
export const problemsOf = (files, read = (path) => readFileSync(path, 'utf8')) => {
  const problems = [];

  for (const path of files) {
    const allowed = ALLOWED[path] ?? [];
    const counts = countsOf(read(path), path);

    for (const { line, expression } of counts) {
      if (!allowed.includes(expression)) {
        problems.push(
          `${path}:${String(line)}: "{${expression}} bytes" writes "1 bytes" at 1; write the count through the side's helper (byteCountOf, FailureException.ByteCountOf, byte_count_of), or allow it in tools/check-byte-counts.mjs only if it can never be 1`
        );
      }
    }
    for (const expression of allowed) {
      if (
        !counts.some((count) => {
          return count.expression === expression;
        })
      ) {
        problems.push(`${path}: the allowed count "${expression}" is gone; drop it from ALLOWED`);
      }
    }
  }

  return problems;
};

/**
 * The paths among `paths` the scan reads: every side's sources, its tests aside, Rust's module
 * tests in `src/<module>/tests.rs` and `src/<module>/tests/` among them, and the DevTools
 * extension's and the demo's.
 */
export const sourcesOf = (paths) => {
  return paths.filter((path) => {
    return (
      /\.(ts|cs|rs)$/.test(path) &&
      /\/src\//.test(path) &&
      !/__tests__|\.Tests\/|\/tests\.rs$|\/tests\/|\/devtools\/|\/demo\//.test(path)
    );
  });
};

if (import.meta.main) {
  const args = process.argv.slice(2);
  const files =
    args.length > 0
      ? args
      : sourcesOf(
          execFileSync('git', ['ls-files', '-z', 'implementations'], { encoding: 'utf8' }).split(
            '\0'
          )
        ).concat(Object.keys(ALLOWED));
  const problems = problemsOf([...new Set(files)]);

  for (const problem of problems) {
    console.error(problem);
  }
  process.exit(problems.length > 0 ? 1 : 0);
}
