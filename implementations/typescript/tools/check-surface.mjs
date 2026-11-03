#!/usr/bin/env node
// ── The package's surface, pinned to its list, and its options judged ────────
// Reads each entry of `package.json`'s `exports` through TypeScript 7's checker (its
// `unstable/sync` API, at the version the lockfile pins) and holds two things (decisions 0004 and
// 0006):
//
// - the surface: each entry's exports, then each declaration they name, with its members — a
//   function's signature, an interface's members and those it inherits, a type's text, a class's
//   public members, the methods of a factory's return type that no entry names — kept to the
//   declarations under `src/`, must be `surface.txt` beside `package.json`, so the surface grows by
//   a change of that file, never by accident;
// - the options rule: the options parameter of every exported function, and of every method of an
//   exported type or of a factory's return type, is required exactly when a member of its type is,
//   with two members required at most. A parameter is the options when it comes last and its type,
//   `undefined` aside, is named `…Options`, or holds one in an intersection; a rest is judged by the
//   last element of its tuple, a conditional one by each of its arms, never by a tuple's array
//   members; options typed by a type parameter are judged where an instantiation is exported.
//
// What the rule waives is `WAIVED`, each with its reason. `bead/options-last` judges what syntax
// shows of the rule; this judges what only the checker knows, a named type's members.
//
// Usage, from the package's folder; `yarn check` runs it as `yarn surface:check`:
//   node tools/check-surface.mjs           the surface against `surface.txt`, and the rule
//   node tools/check-surface.mjs --write   writes `surface.txt` from the surface, and the rule
//   node tools/check-surface.mjs --cases   the rule over `tools/surface.cases.ts`, which must be
//                                          refused on exactly the lines its cases mark

import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = process.cwd();
const SURFACE = 'surface.txt';
const CASES = 'tools/surface.cases.ts';
const CASES_PROJECT = 'tools/surface.cases.tsconfig.json';
// what the cases must mark at least, so a cases file emptied of them cannot pass
const FLOOR = 10;

const require = createRequire(join(ROOT, 'package.json'));
const moduleOf = (specifier) => {
  return import(pathToFileURL(require.resolve(specifier)).href);
};
const { API, ElementFlags, SignatureKind, SymbolFlags } = await moduleOf(
  'typescript-7/unstable/sync'
);
const is = await moduleOf('typescript-7/unstable/ast/is');

/**
 * The rule's waivers, by the declaration's file and name, each with its reason: what it waives is
 * a design to revisit, which a `// TODO` beside the declaration names.
 */
const WAIVED = Object.freeze({
  'src/transcoding/json-form.ts writeFieldJson':
    'three members required, its operand among them: toward `JsonForm` on the C# side, as its TODO says',
});

// `typeToString`'s `NoTruncation`: a type printed whole, however long
const NO_TRUNCATION = 1;

/** An options type's name, its generic arguments aside. */
const OPTIONS_NAME = /Options$/u;

/** The wrappers that keep an object type one: what they wrap names it. */
const WRAPPERS = new Set(['Omit', 'Partial', 'Pick', 'Readonly']);

// ── Reading ──────────────────────────────────────────────────────────────────

/** A path relative to the package, with forward slashes, whatever the platform. */
function relativeOf(fileName) {
  return relative(ROOT, fileName).replaceAll('\\', '/');
}

/** Whether a declaration lies under `src/`, or in the cases when they are judged. */
function isOurs(fileName, scope) {
  const path = relativeOf(fileName);
  return scope.isCases ? path === CASES : path.startsWith('src/');
}

/** A node's file and line, 1-based. */
function placeOf(node) {
  const source = node.getSourceFile();
  const line = source.text.slice(0, node.getStart(source)).split('\n').length;
  return { file: relativeOf(source.fileName), line };
}

/**
 * A declaration's text as the surface pins it: comments dropped, whitespace collapsed, a trailing
 * comma or semicolon dropped, so the formatter's choices never move the list.
 */
function textOf(text) {
  let out = '';
  let quote;
  for (let at = 0; at < text.length; at += 1) {
    const char = text[at];
    if (quote !== undefined) {
      out += char;
      if (char === '\\') {
        out += text[at + 1] ?? '';
        at += 1;
      } else if (char === quote) {
        quote = undefined;
      }
    } else if (char === '/' && text[at + 1] === '/') {
      const end = text.indexOf('\n', at);
      at = end === -1 ? text.length : end - 1;
    } else if (char === '/' && text[at + 1] === '*') {
      const end = text.indexOf('*/', at + 2);
      at = end === -1 ? text.length : end + 1;
    } else {
      if (char === "'" || char === '"' || char === '`') {
        quote = char;
      }
      out += char;
    }
  }
  return out
    .replaceAll(/\s+/gu, ' ')
    .replaceAll(/([([{<]) /gu, '$1')
    .replaceAll(/ ([)\]}>])/gu, '$1')
    .replaceAll(/[,;]([)\]}>])/gu, '$1')
    .replace(/^(export )?(declare )?(default )?/u, '')
    .replace(/[,;]$/u, '')
    .trim();
}

/** A node's text, as the surface pins it. */
function nodeTextOf(node) {
  return textOf(node.getText());
}

/** A function-like node's head: its type parameters, its parameters and its return type, no body. */
function headOf({ name, node }, scope) {
  const types =
    node.typeParameters === undefined ? '' : `<${node.typeParameters.map(nodeTextOf).join(', ')}>`;
  const parameters = node.parameters.map(nodeTextOf).join(', ');
  let returned = '';
  if (node.type !== undefined) {
    returned = `: ${nodeTextOf(node.type)}`;
  } else if (!is.isConstructorDeclaration(node)) {
    const signature = scope.checker.getSignatureFromDeclaration(node);
    const type = signature && scope.checker.getReturnTypeOfSignature(signature);
    returned =
      type === undefined
        ? ''
        : `: ${textOf(scope.checker.typeToString(type, node, NO_TRUNCATION))}`;
  }
  return `${name}${types}(${parameters})${returned}`;
}

/** Whether a class member is written `private` or `#`, which no caller reaches. */
function isPrivate(member) {
  return (
    member.name?.kind === undefined ||
    member.name.getText().startsWith('#') ||
    (member.modifiers ?? []).some((modifier) => {
      return modifier.getText() === 'private' || modifier.getText() === 'protected';
    })
  );
}

/** Each member a type has under `src/`, its own and those it inherits, as its declarations write them. */
function membersOf(type, scope) {
  const lines = [];
  for (const property of scope.checker.getPropertiesOfType(type) ?? []) {
    for (const handle of property.declarations ?? []) {
      const node = handle.resolve();
      if (node !== undefined && isOurs(node.getSourceFile().fileName, scope)) {
        lines.push(nodeTextOf(node));
      }
    }
  }
  return lines;
}

/** What the surface pins of one declaration: its head, then its members, each a line of its own. */
function declarationOf({ name, node }, scope) {
  if (is.isInterfaceDeclaration(node)) {
    const types =
      node.typeParameters === undefined
        ? ''
        : `<${node.typeParameters.map(nodeTextOf).join(', ')}>`;
    const heritage = (node.heritageClauses ?? []).map(nodeTextOf).join(' ');
    const own = node.members
      .filter((member) => {
        return (
          is.isCallSignatureDeclaration(member) ||
          is.isConstructSignatureDeclaration(member) ||
          is.isIndexSignatureDeclaration(member)
        );
      })
      .map(nodeTextOf);
    const symbol = scope.checker.getSymbolAtLocation(node.name);
    const type = symbol && scope.checker.getDeclaredTypeOfSymbol(symbol);
    return [
      `interface ${name}${types}${heritage === '' ? '' : ` ${heritage}`}`,
      ...own,
      ...(type === undefined ? [] : membersOf(type, scope)),
    ];
  }
  if (is.isTypeAliasDeclaration(node) || is.isEnumDeclaration(node)) {
    return [nodeTextOf(node)];
  }
  if (is.isClassDeclaration(node)) {
    const heritage = (node.heritageClauses ?? []).map(nodeTextOf).join(' ');
    const members = node.members
      .filter((member) => {
        return is.isConstructorDeclaration(member) || !isPrivate(member);
      })
      .map((member) => {
        if (
          is.isConstructorDeclaration(member) ||
          is.isMethodDeclaration(member) ||
          is.isGetAccessorDeclaration(member) ||
          is.isSetAccessorDeclaration(member)
        ) {
          const memberName = is.isConstructorDeclaration(member)
            ? 'constructor'
            : member.name.getText();
          return headOf({ name: memberName, node: member }, scope);
        }
        if (is.isPropertyDeclaration(member)) {
          const type = member.type === undefined ? '' : `: ${nodeTextOf(member.type)}`;
          return `${member.name.getText()}${member.questionToken === undefined ? '' : '?'}${type}`;
        }
        return nodeTextOf(member);
      });
    return [`class ${name}${heritage === '' ? '' : ` ${heritage}`}`, ...members];
  }
  if (is.isFunctionDeclaration(node)) {
    return [`function ${headOf({ name, node }, scope)}`];
  }
  if (is.isVariableDeclaration(node)) {
    if (node.type !== undefined) {
      return [`const ${name}: ${nodeTextOf(node.type)}`];
    }
    const { initializer } = node;
    if (
      initializer !== undefined &&
      (is.isArrowFunction(initializer) || is.isFunctionExpression(initializer))
    ) {
      return [`const ${headOf({ name, node: initializer }, scope)}`];
    }
    const symbol = scope.checker.getSymbolAtLocation(node.name);
    const type = symbol && scope.checker.getTypeOfSymbol(symbol);
    return [
      `const ${name}: ${type === undefined ? '?' : textOf(scope.checker.typeToString(type, node, NO_TRUNCATION))}`,
    ];
  }
  return [nodeTextOf(node)];
}

// ── The options rule ─────────────────────────────────────────────────────────

/** The names a type goes by: its alias's, its own, each part's of an intersection or a union. */
function namesOf(type) {
  const names = [];
  const alias = type.getAliasSymbol?.();
  if (alias !== undefined) {
    names.push(alias.name);
    if (WRAPPERS.has(alias.name)) {
      const [wrapped] = type.getAliasTypeArguments();
      if (wrapped !== undefined) {
        names.push(...namesOf(wrapped));
      }
    }
  }
  const symbol = type.getSymbol?.();
  if (symbol !== undefined) {
    names.push(symbol.name);
  }
  if (type.isIntersectionType() || type.isUnionType()) {
    for (const part of type.getTypes() ?? []) {
      names.push(...namesOf(part));
    }
  }
  return names;
}

/** A conditional type's arms, a nested one's each, or the type itself. */
function armsOf(type) {
  if (type.isConditionalType()) {
    return [...armsOf(type.getTrueType()), ...armsOf(type.getFalseType())];
  }
  return [type];
}

/**
 * The options a signature takes last, as `{ isOptional, node, type }`: a parameter, or the last
 * element of each arm of its rest's tuple; none for a rest of any count.
 */
function optionsOf(signature, scope) {
  const parameters = signature.getParameters();
  const last = parameters.at(-1);
  if (last === undefined) {
    return [];
  }
  const node = last.valueDeclaration?.resolve();
  if (node === undefined) {
    return [];
  }
  const type = scope.checker.getTypeOfSymbol(last);
  if (type === undefined) {
    return [];
  }
  if (node.dotDotDotToken === undefined) {
    const isOptional =
      node.questionToken !== undefined ||
      node.initializer !== undefined ||
      (last.flags & SymbolFlags.Optional) !== 0;
    return [{ isOptional, node, type }];
  }
  return armsOf(type).flatMap((arm) => {
    if (!scope.checker.isTupleType(arm)) {
      return [];
    }
    const flags = arm.getTarget().elementFlags ?? [];
    const elements = scope.checker.getTypeArguments(arm);
    const flag = flags.at(-1);
    const element = elements.at(-1);
    if (flag === undefined || element === undefined || (flag & ElementFlags.Variable) !== 0) {
      return [];
    }
    return [{ isOptional: (flag & ElementFlags.Optional) !== 0, node, type: element }];
  });
}

/** What is wrong with options of `type`, taken optional or not, if anything. */
function faultOf({ isOptional, type }, scope) {
  const bare = scope.checker.getNonNullableType(type) ?? type;
  if (bare.isTypeParameter()) {
    return undefined;
  }
  if (
    !namesOf(bare).some((name) => {
      return OPTIONS_NAME.test(name);
    })
  ) {
    return undefined;
  }
  const required = (scope.checker.getPropertiesOfType(bare) ?? [])
    .filter((member) => {
      return (member.flags & SymbolFlags.Optional) === 0;
    })
    .map((member) => {
      return member.name;
    });
  if (required.length > 0 && isOptional) {
    return `optional, though ${required.join(', ')} of it is required`;
  }
  if (required.length === 0 && !isOptional) {
    return 'required, though every member of it is optional';
  }
  if (required.length > 2) {
    return `${String(required.length)} members required (${required.join(', ')}), where two are the most`;
  }
  return undefined;
}

/** Judges each signature of `type`, called as `where`, into `scope.faults`. */
function judgeCallable({ type, where }, scope) {
  for (const signature of scope.checker.getSignaturesOfType(type, SignatureKind.Call) ?? []) {
    for (const options of optionsOf(signature, scope)) {
      const fault = faultOf(options, scope);
      if (fault === undefined) {
        continue;
      }
      const place = placeOf(options.node);
      const declaration = signature.declaration?.resolve();
      const owner = declaration?.parent?.name?.getText() ?? declaration?.name?.getText();
      if (Object.hasOwn(WAIVED, `${place.file} ${owner ?? ''}`)) {
        continue;
      }
      scope.faults.set(`${where}\t${fault}`, place);
    }
  }
}

/**
 * Judges the methods of `type`, called as `where`: each of its properties declared under `src/`
 * that can be called. An array's or a tuple's are the platform's, never judged.
 */
function judgeMethods({ type, where }, scope) {
  if (
    type === undefined ||
    scope.judged.has(`${where} ${String(type.id)}`) ||
    scope.checker.isArrayLikeType(type) ||
    scope.checker.isTupleType(type)
  ) {
    return;
  }
  scope.judged.add(`${where} ${String(type.id)}`);
  for (const property of scope.checker.getPropertiesOfType(type) ?? []) {
    const isDeclaredHere = (property.declarations ?? []).some((handle) => {
      const node = handle.resolve();
      return node !== undefined && isOurs(node.getSourceFile().fileName, scope);
    });
    const propertyType = isDeclaredHere ? scope.checker.getTypeOfSymbol(property) : undefined;
    if (propertyType !== undefined) {
      judgeCallable({ type: propertyType, where: `${where}.${property.name}` }, scope);
    }
  }
}

// ── The walk ─────────────────────────────────────────────────────────────────

/** Every entry of `exports` with its file, the `package.json` entry aside. */
function entriesOf() {
  const { exports } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  return Object.entries(exports).filter(([, file]) => {
    return file.endsWith('.ts');
  });
}

/**
 * Reads what `files` export, by entry, and judges each export's options: the surface's lines, the
 * names read, and the faults, each with its place.
 */
function walk(project, { entries, isCases }) {
  const { checker, program } = project;
  const scope = { checker, faults: new Map(), isCases, judged: new Set() };
  const failures = [];
  const listed = [];
  const declarations = new Map();
  const exportedIds = new Set();
  const read = [];

  for (const [entry, file] of entries) {
    const source = program.getSourceFile(join(ROOT, file));
    const moduleSymbol = source && checker.getSymbolAtLocation(source);
    if (moduleSymbol === undefined) {
      failures.push(`${entry}: ${file} cannot be read`);
      continue;
    }
    const exported = checker.getExportsOfModule(moduleSymbol).map((alias) => {
      const symbol = alias.flags & SymbolFlags.Alias ? checker.getAliasedSymbol(alias) : alias;
      exportedIds.add(symbol.id);
      return { name: alias.name, symbol };
    });
    exported.sort((a, b) => {
      return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
    });
    read.push({ entry, exported });
  }

  for (const { entry, exported } of read) {
    listed.push(`${entry}`);
    for (const { name, symbol } of exported) {
      const nodes = (symbol.declarations ?? [])
        .map((handle) => {
          return handle.resolve();
        })
        .filter((node) => {
          return node !== undefined;
        });
      const ours = nodes.filter((node) => {
        return isOurs(node.getSourceFile().fileName, scope);
      });
      const where = ours[0] === undefined ? 'outside src' : placeOf(ours[0]).file;
      listed.push(`  ${name}\t${where}`);

      for (const node of ours) {
        const key = `${placeOf(node).file} ${symbol.name}`;
        if (!declarations.has(key)) {
          declarations.set(key, declarationOf({ name: symbol.name, node }, scope));
        }
      }
      if (ours.length === 0) {
        continue;
      }

      if (symbol.flags & SymbolFlags.Type) {
        judgeMethods(
          { type: checker.getDeclaredTypeOfSymbol(symbol), where: `${entry} ${name}` },
          scope
        );
      }
      if (symbol.flags & SymbolFlags.Value) {
        const type = checker.getTypeOfSymbol(symbol);
        if (type === undefined) {
          continue;
        }
        judgeCallable({ type, where: `${entry} ${name}` }, scope);
        for (const signature of checker.getSignaturesOfType(type, SignatureKind.Call) ?? []) {
          const returned = checker.getReturnTypeOfSignature(signature);
          judgeMethods({ type: returned, where: `${entry} ${name}()` }, scope);
          // what a factory returns that no entry names: its members pinned with it
          const named = returned?.getAliasSymbol?.() ?? returned?.getSymbol?.();
          const key = `${placeOf(ours[0]).file} ${symbol.name}`;
          if (
            named !== undefined &&
            !exportedIds.has(named.id) &&
            (named.declarations ?? []).some((handle) => {
              const node = handle.resolve();
              return node !== undefined && isOurs(node.getSourceFile().fileName, scope);
            })
          ) {
            const members = membersOf(returned, scope).map((line) => {
              return `returns ${line}`;
            });
            declarations.set(key, [...(declarations.get(key) ?? []), ...members]);
          }
        }
      }
    }
  }

  const lines = [...listed, ''];
  const keys = [...declarations.keys()].sort((a, b) => {
    return a < b ? -1 : a > b ? 1 : 0;
  });
  for (const key of keys) {
    const [head, ...members] = declarations.get(key);
    const indented = [...new Set(members)].map((member) => {
      return `    ${member}`;
    });
    lines.push(key, `  ${head}`, ...indented);
  }

  const names = read.reduce((count, { exported }) => {
    return count + exported.length;
  }, 0);
  return { failures, faults: scope.faults, lines, names };
}

// ── The check ────────────────────────────────────────────────────────────────

/** The lines the cases mark refused: each the line below a `// refused:` comment of its own. */
function markedLines(source) {
  const marked = new Set();
  source.split('\n').forEach((line, index) => {
    if (/^\s*\/\/ refused:/u.test(line)) {
      marked.add(index + 2);
    }
  });
  return marked;
}

const mode = process.argv[2];
const isCases = mode === '--cases';
const client = new API({ cwd: ROOT });
const failures = [];
let summary;

try {
  const project = client
    .updateSnapshot({ openProjects: [join(ROOT, isCases ? CASES_PROJECT : 'tsconfig.json')] })
    .getProjects()[0];
  const entries = isCases ? [['cases', CASES]] : entriesOf();
  const walked = walk(project, { entries, isCases });
  failures.push(...walked.failures);
  if (walked.names === 0) {
    failures.push('no name was read: the check is not running');
  }

  if (isCases) {
    // cases that do not compile could still be read, and pass for nothing
    const file = join(ROOT, CASES);
    for (const diagnostic of [
      ...project.program.getSyntacticDiagnostics(file),
      ...project.program.getSemanticDiagnostics(file),
    ]) {
      failures.push(`${CASES} does not compile: TS${String(diagnostic.code)} ${diagnostic.text}`);
    }
    const marked = markedLines(readFileSync(file, 'utf8'));
    const refused = new Map(
      [...walked.faults].map(([fault, place]) => {
        return [place.line, fault];
      })
    );
    if (marked.size < FLOOR) {
      failures.push(
        `the cases mark ${String(marked.size)} lines, under the floor of ${String(FLOOR)}, so a pass here would mean nothing`
      );
    }
    for (const line of marked) {
      if (!refused.has(line)) {
        failures.push(`${CASES}:${String(line)} — marked refused, and accepted`);
      }
    }
    for (const [line, fault] of refused) {
      if (!marked.has(line)) {
        failures.push(`${CASES}:${String(line)} — refused, and not marked: ${fault}`);
      }
    }
    summary = `the options rule refuses the ${String(marked.size)} lines its cases mark, and no other`;
  } else {
    for (const [fault, place] of walked.faults) {
      failures.push(`${place.file}:${String(place.line)} — ${fault.replace('\t', ': ')}`);
    }
    const text = `${walked.lines.join('\n')}\n`;
    if (mode === '--write') {
      writeFileSync(join(ROOT, SURFACE), text);
      summary = `wrote ${SURFACE}: ${String(walked.names)} names over ${String(entries.length)} entries`;
    } else {
      let pinned = '';
      try {
        pinned = readFileSync(join(ROOT, SURFACE), 'utf8').replaceAll('\r\n', '\n');
      } catch {
        failures.push(`${SURFACE} is missing: \`yarn surface:write\` writes it`);
      }
      if (pinned !== '' && pinned !== text) {
        const was = new Set(pinned.split('\n'));
        const now = new Set(text.split('\n'));
        const gone = [...was].filter((line) => {
          return !now.has(line);
        });
        const came = [...now].filter((line) => {
          return !was.has(line);
        });
        failures.push(
          `the surface is not ${SURFACE}; \`yarn surface:write\` writes it, a change of the surface on purpose:`,
          ...gone.slice(0, 20).map((line) => {
            return `- ${line}`;
          }),
          ...came.slice(0, 20).map((line) => {
            return `+ ${line}`;
          })
        );
      }
      summary = `${String(walked.names)} names over ${String(entries.length)} entries are ${SURFACE}, and their options hold the rule`;
    }
  }
} finally {
  client.close();
}

if (failures.length > 0) {
  console.error(`check-surface: ${String(failures.length)} failure(s).`);
  for (const failure of failures) {
    console.error(`  - ${failure}`);
  }
  process.exit(1);
}

console.log(`check-surface: ${summary}`);
