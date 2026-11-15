// ── Demo highlight ───────────────────────────────────────────────────────────

// Code coloured as the page beadproto.dev colours it: its comments, strings, numbers and keywords,
// by a scanner that knows no grammar and needs none for a snippet or an example's file. Each
// language has its keywords and its strings; the page's build and the demo read it alike, and each
// gives a kind its colour.

// types

/** A language the scanner reads, by the name a block of code gives it. */
export type CodeLanguage =
  | 'csharp'
  | 'json'
  | 'plaintext'
  | 'proto'
  | 'rust'
  | 'shell'
  | 'toml'
  | 'typescript';

/** What a token is: a kind coloured, or `text`, left as it is. */
export type TokenKind = 'comment' | 'keyword' | 'number' | 'string' | 'text';

/** A run of a source of one kind. A source's tokens, joined, give it back whole. */
export interface IToken {
  kind: TokenKind;
  text: string;
}

/** How a scanner reads a language: what opens a comment, what a string is, which words are keywords. */
interface ILanguageOptions {
  comment: string;
  keywords: ReadonlySet<string>;
  /** What reads as text though a keyword is in it, tried once the strings fail. */
  plain?: string;
  strings: readonly string[];
}

/** A language's scanner: its pattern, a group a kind, and its keywords. */
interface IScanner {
  keywords: ReadonlySet<string>;
  pattern: RegExp;
}

// helpers

const wordsOf = (list: string): ReadonlySet<string> => {
  return new Set(list.split(' '));
};

const scannerOf = (options: ILanguageOptions): IScanner => {
  return {
    keywords: options.keywords,
    pattern: new RegExp(
      [
        `(?<comment>${options.comment})`,
        `(?<string>${options.strings.join('|')})`,
        ...(options.plain === undefined ? [] : [`(?<plain>${options.plain})`]),
        `(?<number>${NUMBER})`,
        WORD,
      ].join('|'),
      'gu'
    ),
  };
};

// what a match of a scanner is, by the group that matched it
const kindOf = (match: RegExpExecArray, keywords: ReadonlySet<string>): TokenKind => {
  const { comment, number, plain, string } = match.groups ?? {};

  if (comment !== undefined) {
    return 'comment';
  }

  if (string !== undefined) {
    return 'string';
  }

  if (number !== undefined) {
    return 'number';
  }

  if (plain !== undefined) {
    return 'text';
  }

  return keywords.has(match[0]) ? 'keyword' : 'text';
};

// constants

// the one set the page has coloured TypeScript, .proto, TOML and the shell by
const KEYWORDS = wordsOf(
  'as async await break case catch class const continue default else enum export extends false finally for from function if import in instanceof interface let message new null of package repeated return static switch syntax this throw true try type typeof undefined using var void while yield'
);

// C#'s reserved words, and the contextual ones its code reads as keywords
const CSHARP_KEYWORDS = wordsOf(
  'abstract and as async await base bool break byte case catch char checked class const continue decimal default delegate do double else enum event explicit extern false finally fixed float for foreach get goto if implicit in init int interface internal is lock long nameof namespace new not null object operator or out override params partial private protected public readonly record ref required return sbyte sealed set short sizeof stackalloc static string struct switch this throw true try typeof uint ulong unchecked unsafe ushort using var virtual void volatile when while with yield'
);

// Rust's strict keywords
const RUST_KEYWORDS = wordsOf(
  'as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while'
);

const SLASH_COMMENT = String.raw`\/\/[^\n]*`;

const HASH_COMMENT = String.raw`#[^\n]*`;

// a string on its line, in double or single quotes
const DOUBLE_QUOTED = String.raw`"(?:[^"\\\n]|\\.)*"`;

const SINGLE_QUOTED = String.raw`'(?:[^'\\\n]|\\.)*'`;

// a template literal, over as many lines as it takes
const BACKTICKED = String.raw`\x60(?:[^\x60\\]|\\.)*\x60`;

// C#'s interpolated string, its holes inside it, and its verbatim one, where `""` is a quote
const INTERPOLATED = String.raw`\$"(?:[^"\\{\n]|\\.|\{\{|\{[^}\n]*\})*"`;

const VERBATIM = String.raw`@"(?:[^"]|"")*"`;

// Rust's raw string, closed by as many `#` as opened it; its string, over lines; and its
// character, which a lifetime (`'a`) is not
const RAW = String.raw`\bb?r(?<hashes>#*)"[\s\S]*?"\k<hashes>`;

const RUST_STRING = String.raw`"(?:[^"\\]|\\[\s\S])*"`;

const RUST_CHARACTER = String.raw`'(?:[^'\\\n]|\\(?:u\{[0-9a-fA-F]+\}|x[0-9a-fA-F]{2}|.))'`;

// a lifetime or a loop's label, `'static` or `'outer`, whose word is no keyword there
const LIFETIME = String.raw`'[A-Za-z_]\w*`;

const NUMBER = String.raw`\b(?:0x[0-9a-fA-F_]+|\d[\d_]*(?:\.\d+)?(?:e[+-]?\d+)?)\b`;

const WORD = String.raw`[A-Za-z_$][\w$]*`;

const QUOTED = [DOUBLE_QUOTED, SINGLE_QUOTED, BACKTICKED];

/** Each language's scanner; plain text has none, and is one token. */
const SCANNERS: Readonly<Record<CodeLanguage, IScanner | null>> = Object.freeze({
  csharp: scannerOf({
    comment: SLASH_COMMENT,
    keywords: CSHARP_KEYWORDS,
    strings: [INTERPOLATED, VERBATIM, DOUBLE_QUOTED, SINGLE_QUOTED],
  }),
  json: scannerOf({ comment: SLASH_COMMENT, keywords: new Set(), strings: QUOTED }),
  plaintext: null,
  proto: scannerOf({ comment: SLASH_COMMENT, keywords: KEYWORDS, strings: QUOTED }),
  rust: scannerOf({
    comment: SLASH_COMMENT,
    keywords: RUST_KEYWORDS,
    plain: LIFETIME,
    strings: [RAW, RUST_STRING, RUST_CHARACTER],
  }),
  shell: scannerOf({ comment: HASH_COMMENT, keywords: KEYWORDS, strings: QUOTED }),
  toml: scannerOf({ comment: HASH_COMMENT, keywords: KEYWORDS, strings: QUOTED }),
  typescript: scannerOf({ comment: SLASH_COMMENT, keywords: KEYWORDS, strings: QUOTED }),
});

// definition

/**
 * The tokens of `source` in `language`: its comments, strings, numbers and keywords, and the text
 * between them, each run of text one token. Throws on a language it has no scanner for.
 */
export const tokensOf = (source: string, language: CodeLanguage): IToken[] => {
  if (!Object.hasOwn(SCANNERS, language)) {
    throw new Error(`highlight: no scanner for ${language}`);
  }

  const scanner = SCANNERS[language];
  const tokens: IToken[] = [];

  const push = (kind: TokenKind, text: string): void => {
    const last = tokens.at(-1);

    if (text === '') {
      return;
    }

    if (kind === 'text' && last?.kind === 'text') {
      last.text += text;
    } else {
      tokens.push({ kind, text });
    }
  };

  if (scanner === null) {
    push('text', source);

    return tokens;
  }

  let at = 0;

  for (const match of source.matchAll(scanner.pattern)) {
    push('text', source.slice(at, match.index));
    push(kindOf(match, scanner.keywords), match[0]);
    at = match.index + match[0].length;
  }

  push('text', source.slice(at));

  return tokens;
};
