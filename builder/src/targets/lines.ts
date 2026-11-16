// ── Lines ─────────────────────────────────────────────────────────────────────

// How the C# and the Rust targets write their code: as lines of text, one level of indentation
// `INDENT`, four spaces, as `dotnet format` and rustfmt indent alike. A template gathers its lines
// in arrays, a level's indentation written before each line; a body written a line at a time is
// `printerOf`'s, each line at its depth; a statement whose value spans lines is `statementOf`'s.
// The TypeScript target writes through protoplugin's `GeneratedFile` instead. This module imports
// nothing.

// constants

/** One level of indentation, `dotnet format`'s and rustfmt's. */
export const INDENT = '    ';

// definition

/** A printer into `lines`: each line at `depth` levels of `INDENT`, an empty line left empty. */
export const printerOf = (lines: string[]): ((depth: number, line: string) => void) => {
  return (depth, line) => {
    lines.push(line === '' ? '' : `${INDENT.repeat(depth)}${line}`);
  };
};

/**
 * A statement, `head` then a value of several lines at `details.indent`, its last line ending it
 * with `;`: `head` and a value of one line on one line.
 */
export const statementOf = (
  head: string,
  details: { readonly value: readonly string[]; readonly indent: string }
): string[] => {
  const [first, ...rest] = details.value;

  if (rest.length === 0) {
    return [`${details.indent}${head}${String(first)};`];
  }

  return [
    `${details.indent}${head}${String(first)}`,
    ...rest.slice(0, -1),
    `${String(rest.at(-1))};`,
  ];
};
