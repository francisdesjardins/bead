#!/usr/bin/env node
// ── The package's surface, pinned to its list, its options and tuples judged ─
// Reads each entry of `package.json`'s `exports` through TypeScript 7's checker (its
// `unstable/sync` API, at the version the lockfile pins) and holds four things (decisions 0047 and
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
//   members; options typed by a type parameter are judged where an instantiation is exported;
// - the record rule: no exported function or method takes a parameter typed as an inline object
//   that is not its options — the last parameter when it is optional or follows another, or one
//   named `options`: two things are two parameters, and a third a record of the call, named. A
//   literal of index signatures alone is a map, one value, never judged;
// - the tuple rule: no export takes or gives a tuple, at any depth of a parameter's, a return's, a
//   member's, an alias's or a constant's type, written or inferred, an alias of ours judged by what
//   it names; nor takes an array apart in a parameter. A parameter list stays: a rest's own tuple,
//   and at depth one whose every element is labeled, an event map's; a non-rest parameter's or a
//   return's own type is never one. A conditional type's `[X] extends [Y]` is no value, skipped.
//
// What the tuple rule waives is `WAIVED_TUPLES`, and the record rule `WAIVED_INLINE_OBJECTS`, each
// with its reason; the options rule waives nothing. `bead/options-last` judges what syntax shows of
// the options rule; this judges what only the checker knows, a named type's members and what the
// package exports, which a module's own `export` does not tell.
//
// Usage, from the package's folder; `yarn check` runs it as `yarn surface:check`:
//   node tools/check-surface.mjs           the surface against `surface.txt`, and the rules
//   node tools/check-surface.mjs --write   writes `surface.txt` from the surface, and the rules
//   node tools/check-surface.mjs --cases   the rules over `tools/surface.cases.ts`, which must be
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
const FLOOR = 20;

const require = createRequire(join(ROOT, 'package.json'));
const moduleOf = (specifier) => {
  return import(pathToFileURL(require.resolve(specifier)).href);
};
const { API, ElementFlags, SignatureKind, SymbolFlags } = await moduleOf(
  'typescript-7/unstable/sync'
);
const is = await moduleOf('typescript-7/unstable/ast/is');

// `typeToString`'s `NoTruncation`: a type printed whole, however long
const NO_TRUNCATION = 1;

/**
 * The tuple rule's waivers, by the declaration's file and name, each with its reason: what the
 * platform types as a tuple, no value of Bead's a caller builds.
 */
const WAIVED_TUPLES = Object.freeze({
  'src/proto/validate.ts entriesByKey': "a map's entries as ECMA-262's Object.entries gives them",
  'src/transport/server/http-policy.ts HTTP_POLICY_MEMBERS':
    'a frozen list of names, which as const types as a tuple',
});

/**
 * The record rule's waivers, by the declaration's file and its `owner.member(parameter)`, each with
 * its reason. ! The list only shrinks: a new one is two parameters, or a record of the call, named.
 */
const WAIVED_INLINE_OBJECTS = Object.freeze({
  'src/transport/shared/broker-participant.ts IBrokerConnectionOwner.envelope(message)':
    'one value, an envelope and the credential it came with, on a type the TypeScript side alone exports: named, or off the surface, as the reading of the names one side alone holds places it',
  'src/transport/shared/broker-participant.ts IBrokerParticipantPort.connect(pair)':
    "a connection's two halves and its peer, on a type the TypeScript side alone exports: named, or off the surface, as the reading of the names one side alone holds places it",
});

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
      scope.faults.set(`${where}\t${fault}`, placeOf(options.node));
    }
    judgeRecords({ signature, where }, scope);
  }
}

// ── The record rule ──────────────────────────────────────────────────────────

/**
 * Whether a type, as written, is an inline record: a type literal holding a member that is no index
 * signature, under the wrappers, or an intersection or a union holding one.
 */
function isInlineRecord(node) {
  if (node === undefined) {
    return false;
  }
  if (is.isTypeLiteralNode(node)) {
    return node.members.some((member) => {
      return !is.isIndexSignatureDeclaration(member);
    });
  }
  if (is.isTypeReferenceNode(node)) {
    return WRAPPERS.has(node.typeName.getText()) && isInlineRecord(node.typeArguments?.[0]);
  }
  if (is.isIntersectionTypeNode(node) || is.isUnionTypeNode(node)) {
    return node.types.some(isInlineRecord);
  }
  return false;
}

/** The names of the declarations around a parameter, outermost first: `IOwner.member`. */
function ownerOf(parameter) {
  const names = [];
  for (let at = parameter.parent; at !== undefined && !is.isSourceFile(at); at = at.parent) {
    const name = at.name?.getText();
    if (name !== undefined) {
      names.unshift(name);
    }
  }
  return names.join('.');
}

/**
 * Judges the parameters of `signature`, called as `where`: each typed as an inline record is
 * refused, but the options — the last parameter when it is optional or follows another, or one
 * named `options` — and those `WAIVED_INLINE_OBJECTS` names. Each is judged once, however many
 * exports reach it.
 */
function judgeRecords({ signature, where }, scope) {
  const parameters = signature.getParameters();
  parameters.forEach((parameter, index) => {
    const node = parameter.valueDeclaration?.resolve();
    if (node === undefined || node.dotDotDotToken !== undefined || !isInlineRecord(node.type)) {
      return;
    }
    const name = node.name.getText();
    const isOptional =
      node.questionToken !== undefined ||
      node.initializer !== undefined ||
      (parameter.flags & SymbolFlags.Optional) !== 0;
    const isLast = index === parameters.length - 1;
    if (name === 'options' || (isLast && (isOptional || index > 0))) {
      return;
    }
    const place = placeOf(node);
    const key = `${place.file} ${ownerOf(node)}(${name})`;
    if (Object.hasOwn(WAIVED_INLINE_OBJECTS, key) || scope.recorded.has(key)) {
      return;
    }
    scope.recorded.add(key);
    scope.faults.set(
      `${where}\tan inline object, ${name}: two things are two parameters, a third a record of the call, named`,
      place
    );
  });
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

// ── The tuple rule ───────────────────────────────────────────────────────────

/** Records a tuple taken or given at `node`, once however many exports reach it. */
function refuseTuple({ node, text }, scope) {
  const place = placeOf(node);
  const key = `${place.file}:${String(node.pos)} ${text}`;
  if (scope.tupled.has(key)) {
    return;
  }
  scope.tupled.add(key);
  scope.faults.set(`${scope.where}\t${text}`, place);
}

/** Whether `WAIVED_TUPLES` names a declaration, wherever it is reached from. */
function isWaivedTuple(node) {
  return Object.hasOwn(WAIVED_TUPLES, `${placeOf(node).file} ${node.name?.getText() ?? ''}`);
}

/** Whether a tuple type writes a parameter list: every element labeled. */
function isParameterList(node) {
  return node.elements.every((element) => {
    return is.isNamedTupleMember(element);
  });
}

/** A tuple element's own type: what its label, its `...` or its `?` wraps. */
function elementTypeOf(element) {
  return is.isNamedTupleMember(element) ||
    is.isRestTypeNode(element) ||
    is.isOptionalTypeNode(element)
    ? element.type
    : element;
}

/** Judges a type parameter's constraint and default, each a type at depth. */
function judgeTypeParameters(node, scope) {
  for (const parameter of node.typeParameters ?? []) {
    judgeTypeNode({ node: parameter.constraint, role: 'depth' }, scope);
    judgeTypeNode({ node: parameter.default, role: 'depth' }, scope);
  }
}

/**
 * Judges a type as written. `role` is what it types: `own`, a parameter's, a return's or a
 * constant's own type, never a tuple; `rest`, a rest's, whose own tuple is the parameter list
 * itself; `depth`, any other place, where a tuple every element of which is labeled is a parameter
 * list — an event map's, `Parameters<…>`'s — and any other is refused.
 */
function judgeTypeNode({ node, role }, scope) {
  if (node === undefined) {
    return;
  }
  if (is.isTupleTypeNode(node)) {
    if (role === 'own' || (role === 'depth' && !isParameterList(node))) {
      refuseTuple({ node, text: `a tuple, ${nodeTextOf(node)}` }, scope);
    }
    for (const element of node.elements) {
      judgeTypeNode({ node: elementTypeOf(element), role: 'depth' }, scope);
    }
    return;
  }
  // * `[X] extends [Y]` is the checker's idiom against distribution, no value: its arms alone
  if (is.isConditionalTypeNode(node)) {
    judgeTypeNode({ node: node.trueType, role }, scope);
    judgeTypeNode({ node: node.falseType, role }, scope);
    return;
  }
  if (is.isParenthesizedTypeNode(node) || is.isTypeOperatorNode(node)) {
    judgeTypeNode({ node: node.type, role }, scope);
    return;
  }
  if (is.isUnionTypeNode(node)) {
    for (const part of node.types) {
      judgeTypeNode({ node: part, role }, scope);
    }
    return;
  }
  if (is.isTypeReferenceNode(node) || is.isExpressionWithTypeArguments(node)) {
    followName(
      { name: is.isTypeReferenceNode(node) ? node.typeName : node.expression, role },
      scope
    );
    for (const argument of node.typeArguments ?? []) {
      judgeTypeNode({ node: argument, role: 'depth' }, scope);
    }
    return;
  }
  if (is.isFunctionTypeNode(node) || is.isConstructorTypeNode(node)) {
    judgeSignatureNode(node, scope);
    return;
  }
  if (is.isTypeLiteralNode(node)) {
    for (const member of node.members) {
      judgeMember(member, scope);
    }
    return;
  }
  // a value's type, or a module's, is judged where it is declared, if ours
  if (is.isTypeQueryNode(node) || is.isImportTypeNode(node)) {
    return;
  }
  node.forEachChild((child) => {
    judgeTypeNode({ node: child, role: 'depth' }, scope);
  });
}

/**
 * Judges a type as the checker reads it, where nothing is written: a tuple at any depth of its
 * type arguments or of a union's or an intersection's parts, and a declaration of ours by its own.
 */
function judgeType({ node, seen = new Set(), type }, scope) {
  if (type === undefined || seen.has(type.id)) {
    return;
  }
  seen.add(type.id);
  const { checker } = scope;
  if (checker.isTupleType(type)) {
    refuseTuple(
      { node, text: `a tuple, ${textOf(checker.typeToString(type, node, NO_TRUNCATION))}` },
      scope
    );
    return;
  }
  if (type.isUnionType() || type.isIntersectionType()) {
    for (const part of type.getTypes() ?? []) {
      judgeType({ node, seen, type: part }, scope);
    }
    return;
  }
  if (type.isTypeReference()) {
    for (const argument of checker.getTypeArguments(type) ?? []) {
      judgeType({ node, seen, type: argument }, scope);
    }
  }
  for (const handle of type.getSymbol?.()?.declarations ?? []) {
    const declaration = handle.resolve();
    if (declaration === undefined || !isOurs(declaration.getSourceFile().fileName, scope)) {
      continue;
    }
    if (is.isObjectLiteralExpression(declaration)) {
      for (const property of declaration.properties) {
        judgeMember(property, scope);
      }
    } else {
      judgeDeclarationOnce(declaration, scope);
    }
  }
}

/**
 * Judges a function-like declaration: its type parameters, each parameter — none an array taken
 * apart, none of a tuple type but a rest — and what it returns, as written or as inferred.
 */
function judgeSignatureNode(node, scope) {
  judgeTypeParameters(node, scope);
  for (const parameter of node.parameters) {
    const isRest = parameter.dotDotDotToken !== undefined;
    if (!isRest && is.isArrayBindingPattern(parameter.name)) {
      refuseTuple(
        { node: parameter, text: `an array taken apart, ${nodeTextOf(parameter.name)}` },
        scope
      );
    }
    judgeTypeNode({ node: parameter.type, role: isRest ? 'rest' : 'own' }, scope);
  }
  if (node.type !== undefined) {
    judgeTypeNode({ node: node.type, role: 'own' }, scope);
    return;
  }
  if (
    node.body === undefined ||
    is.isConstructorDeclaration(node) ||
    is.isSetAccessorDeclaration(node)
  ) {
    return;
  }
  const signature = scope.checker.getSignatureFromDeclaration(node);
  const returned = signature && scope.checker.getReturnTypeOfSignature(signature);
  judgeType({ node, type: returned }, scope);
}

/** Judges a member of an interface, a type literal, a class or an object literal. */
function judgeMember(member, scope) {
  const initializer = is.isPropertyAssignment(member) ? member.initializer : undefined;
  if (
    initializer !== undefined &&
    (is.isArrowFunction(initializer) || is.isFunctionExpression(initializer))
  ) {
    judgeSignatureNode(initializer, scope);
    return;
  }
  if (member.parameters !== undefined) {
    judgeSignatureNode(member, scope);
    return;
  }
  if (member.type !== undefined) {
    judgeTypeNode({ node: member.type, role: 'depth' }, scope);
    return;
  }
  const symbol = member.name && scope.checker.getSymbolAtLocation(member.name);
  judgeType({ node: member, type: symbol && scope.checker.getTypeOfSymbol(symbol) }, scope);
}

/** Judges the declarations of ours a type's name stands for: an alias by what it names. */
function followName({ name, role }, scope) {
  let symbol = scope.checker.getSymbolAtLocation(name);
  if (symbol !== undefined && symbol.flags & SymbolFlags.Alias) {
    symbol = scope.checker.getAliasedSymbol(symbol);
  }
  for (const handle of symbol?.declarations ?? []) {
    const declaration = handle.resolve();
    if (declaration === undefined || !isOurs(declaration.getSourceFile().fileName, scope)) {
      continue;
    }
    if (isWaivedTuple(declaration)) {
      continue;
    }
    if (is.isTypeAliasDeclaration(declaration)) {
      const key = `${placeOf(declaration).file}:${String(declaration.pos)} ${role}`;
      if (!scope.tupled.has(key)) {
        scope.tupled.add(key);
        judgeTypeParameters(declaration, scope);
        judgeTypeNode({ node: declaration.type, role }, scope);
      }
    } else if (is.isInterfaceDeclaration(declaration) || is.isClassDeclaration(declaration)) {
      judgeDeclarationOnce(declaration, scope);
    }
  }
}

/** Judges a declaration of ours once, however many exports name it. */
function judgeDeclarationOnce(node, scope) {
  const key = `${placeOf(node).file}:${String(node.pos)} declaration`;
  if (scope.tupled.has(key) || isWaivedTuple(node)) {
    return;
  }
  scope.tupled.add(key);
  if (is.isTypeAliasDeclaration(node)) {
    followName({ name: node.name, role: 'depth' }, scope);
  } else if (is.isInterfaceDeclaration(node) || is.isClassDeclaration(node)) {
    judgeTypeParameters(node, scope);
    for (const clause of node.heritageClauses ?? []) {
      for (const type of clause.types) {
        judgeTypeNode({ node: type, role: 'depth' }, scope);
      }
    }
    for (const member of node.members) {
      if (
        !is.isClassDeclaration(node) ||
        is.isConstructorDeclaration(member) ||
        !isPrivate(member)
      ) {
        judgeMember(member, scope);
      }
    }
  } else if (is.isFunctionDeclaration(node)) {
    judgeSignatureNode(node, scope);
  } else if (is.isVariableDeclaration(node)) {
    const { initializer } = node;
    if (node.type !== undefined) {
      judgeTypeNode({ node: node.type, role: 'own' }, scope);
    } else if (
      initializer !== undefined &&
      (is.isArrowFunction(initializer) || is.isFunctionExpression(initializer))
    ) {
      judgeSignatureNode(initializer, scope);
    } else {
      const symbol = scope.checker.getSymbolAtLocation(node.name);
      judgeType({ node, type: symbol && scope.checker.getTypeOfSymbol(symbol) }, scope);
    }
  }
}

/** Judges an export's declaration of ours, called as `where`. */
function judgeTuples({ node, where }, scope) {
  scope.where = where;
  judgeDeclarationOnce(node, scope);
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
  const scope = {
    checker,
    faults: new Map(),
    isCases,
    judged: new Set(),
    recorded: new Set(),
    tupled: new Set(),
  };
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
        judgeTuples({ node, where: `${entry} ${name}` }, scope);
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
    summary = `the options, record and tuple rules refuse the ${String(marked.size)} lines their cases mark, and no other`;
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
      summary = `${String(walked.names)} names over ${String(entries.length)} entries are ${SURFACE}, their options hold the rule, none takes an inline record, and none takes or gives a tuple`;
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
