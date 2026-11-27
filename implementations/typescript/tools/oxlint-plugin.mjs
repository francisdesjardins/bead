// The lint's own rules, an oxlint JS plugin named `bead`, which `.oxlintrc.base.json` loads.
//
// `bead/options-last` holds the parameter rule (decisions 0047 and 0007): a function takes at most
// two parameters, then at most one options object, always last, optional when every member is and
// required when one is; an event carries at most two values. `max-params` counts the parameters
// written; this judges what a third may be, and counts where `max-params` does not read: a rest
// tuple, a type's signature, an event map.
//
// It reads syntax alone, never what a name resolves to: a type literal's members it sees, a named
// type's it does not. `check-surface.mjs` judges a named options type through the checker, over
// what the package exports; a callback type aliased under a name ending in `Options` passes here as
// an options object, and stays review's (decision 0006), as the one optional positional where no
// second could come does. `oxlint-plugin.cases.ts` beside it holds a line for
// each verdict, and `check-oxlint-plugin.mjs` fails unless exactly its marked lines are refused.
//
// `bead/wire-literal` holds the notation rule (decision 0057) over the modules that name a wire
// format's numbers and those that read them, as the TypeScript column of the root's
// `tools/wire-names.tsv` lists them. `wire-literal.cases.ts` beside it holds its cases.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// ── Known exceptions ─────────────────────────────────────────────────────────

/**
 * The rests of any count, as `owner(...type)`: the declarations that hold one, outermost first, and
 * its type as written. Each reason says where the values it stands for are judged.
 */
const LISTED_RESTS = Object.freeze({
  'IBoundCall(...Options)':
    "a call's options, one element: a request's `IRequestOptions`, its default, a command's `ICommandOptions`, required, or a registration's `IRegistrationOptions`",
  'createServiceServer(...ServiceServerOptions<S>)':
    "a server side's options, one element, required when a procedure names a hook",
  'EmitterListener(...P)': "an event's values, judged at its map",
  "IClient.connect(...Parameters<Transport['connect']>)":
    "its transport's connect options, one element, as `ITransportClient.connect` takes them",
  'ITransportClient.connect(...ConnectParameters<ConnectOptions>)':
    "a connect's options, one element, required when one of its members is",
  'INotificationContext.named(...never[])':
    'the bound of any callable, which a function named after its procedure keeps whole',
  'nameAfter(...never[])':
    'the bound of any callable, which a function named after its procedure keeps whole',
  'IServiceRequesterOptions.nameAfter(...never[])':
    'the bound of any callable, which a function named after its procedure keeps whole',
  'IServiceResolverOptions.nameAfter(...never[])':
    'the bound of any callable, which a function named after its procedure keeps whole',
  // the tests'
  'IReceiverLike._write(...never[])':
    "`ws`'s own parse, a chunk, its encoding and its end, which a fuzz target calls below its stream",
  'batch(...Uint8Array[])': 'a batch of envelopes, as many as a case puts in it',
  'batchOf(...Uint8Array[])': 'a batch of envelopes, as many as a case puts in it',
  'createFakeHTTPServer.createServer.on(...never[])': 'a fake taking a listener of any event',
  'createFakeHTTPServer.createServer.on(...unknown[])': 'that listener, handed to its emitter',
  'createFakeSocket.socket.on(...never[])': 'a fake taking a listener of any event',
  'createFakeSocket.socket.on(...unknown[])': 'that listener, handed to its emitter',
  'IFakeSocket.hear(...unknown[])':
    "an event a fake socket hears, and its values, as `ws`'s socket emits them",
});

const MESSAGES = Object.freeze({
  event: 'an event carries at most two values',
  fourth: 'two parameters, then at most one options object: this is a fourth',
  notLast: 'the options object comes last',
  optionalOfRequired: 'an options object with a required member is required',
  rest: "a rest of any count: a written tuple, an event's values, or a rest `bead/options-last` lists with its reason",
  second: 'one options object, at most',
  third: 'a third parameter is the options object: an object type, or one named `…Options`',
});

// ── What counts as the options object ────────────────────────────────────────

/** An options type's name, its generic arguments aside. */
const OPTIONS_NAME = /Options$/;

/** The house's name for an event map: `RouterServerEventMap`, `EmitterEventMap<E>`. */
const EVENT_MAP_NAME = /EventMap$/;

/** The wrappers that keep an object type one: what they wrap is judged. */
const WRAPPERS = new Set(['Omit', 'Partial', 'Pick', 'Readonly']);

/** A type reference's name, the last part of a qualified one. */
function nameOf(type) {
  const { typeName } = type;
  return typeName.type === 'Identifier' ? typeName.name : typeName.right.name;
}

function wrapped(type) {
  return type.typeArguments?.params[0];
}

/**
 * Whether `type` is an object type an options object may take: a type literal, a type named
 * `…Options`, either under a wrapper, an intersection of these, a union of these and `undefined`, or
 * `Parameters<…>[n]`, another signature's options, judged where that signature stands.
 */
function isObjectType(type) {
  switch (type?.type) {
    case 'TSTypeLiteral':
      return true;
    case 'TSTypeReference':
      return WRAPPERS.has(nameOf(type))
        ? isObjectType(wrapped(type))
        : OPTIONS_NAME.test(nameOf(type));
    case 'TSIntersectionType':
      return type.types.every(isObjectType);
    case 'TSUnionType':
      return (
        type.types.some(isObjectType) &&
        type.types.every((member) => {
          return member.type === 'TSUndefinedKeyword' || isObjectType(member);
        })
      );
    case 'TSIndexedAccessType':
      return (
        type.objectType.type === 'TSTypeReference' &&
        nameOf(type.objectType) === 'Parameters' &&
        type.indexType.type === 'TSLiteralType'
      );
    default:
      return false;
  }
}

/**
 * Whether `type` names options: a type named `…Options` under the wrappers, or an object type with
 * one among its members. A type literal alone may be a bag of a call's essentials, a parameter like
 * any other, where Deno keeps a plain object for the options alone.
 */
function namesOptions(type) {
  switch (type?.type) {
    case 'TSTypeReference':
      return WRAPPERS.has(nameOf(type))
        ? namesOptions(wrapped(type))
        : OPTIONS_NAME.test(nameOf(type));
    case 'TSIntersectionType':
    case 'TSUnionType':
      return isObjectType(type) && type.types.some(namesOptions);
    default:
      return false;
  }
}

/** Whether an object type writes a required member where syntax sees it. */
function hasRequiredMember(type) {
  switch (type?.type) {
    case 'TSTypeLiteral':
      return type.members.some((member) => {
        return (
          (member.type === 'TSPropertySignature' || member.type === 'TSMethodSignature') &&
          !member.optional
        );
      });
    case 'TSTypeReference':
      return nameOf(type) === 'Readonly' && hasRequiredMember(wrapped(type));
    case 'TSIntersectionType':
      return type.types.some(hasRequiredMember);
    case 'TSUnionType':
      return type.types
        .filter((member) => {
          return member.type !== 'TSUndefinedKeyword';
        })
        .every(hasRequiredMember);
    default:
      return false;
  }
}

// ── The parameters a signature takes ─────────────────────────────────────────

/**
 * One parameter as the rule counts it: a parameter written, or an element of a rest tuple. An
 * unannotated object pattern, or a default that is an object, is an options object as JavaScript
 * writes one. A default makes a parameter optional, as `?` does.
 */
function slotOf(param) {
  const inner = param.type === 'TSParameterProperty' ? param.parameter : param;
  const target = inner.type === 'AssignmentPattern' ? inner.left : inner;
  const type = target.typeAnnotation?.typeAnnotation;
  const isPattern =
    type === undefined &&
    (target.type === 'ObjectPattern' || inner.right?.type === 'ObjectExpression');

  return {
    isObject: isPattern || isObjectType(type),
    isOptional: inner.type === 'AssignmentPattern' || inner.optional === true,
    node: param,
    type,
  };
}

/** An element of a tuple, as one parameter; `undefined` for a rest inside it. */
function elementSlotOf(element) {
  if (element.type === 'TSRestType') {
    return undefined;
  }
  const isOptional =
    element.type === 'TSOptionalType' ||
    (element.type === 'TSNamedTupleMember' && element.optional);
  const type =
    element.type === 'TSNamedTupleMember'
      ? element.elementType
      : element.type === 'TSOptionalType'
        ? element.typeAnnotation
        : element;

  return { isObject: isObjectType(type), isOptional, node: element, type };
}

/** The names of `node` and the declarations around it, outermost first: `INotificationContext.named`. */
function ownerOf(node) {
  const names = [];
  for (let at = node; at !== undefined && at !== null; at = at.parent) {
    const name = at.id?.name ?? (at.type === 'Program' ? undefined : at.key?.name);
    if (name !== undefined && at.type !== 'TSTypeParameter') {
      names.unshift(name);
    }
  }
  return names.join('.');
}

/** Whether `name` is a type parameter around `node` bound to an event map: `E extends EmitterEventMap<E>`. */
function isEventMapParameter(node, name) {
  for (let at = node; at !== undefined && at !== null; at = at.parent) {
    const bound = at.typeParameters?.params.find((parameter) => {
      return (parameter.name.name ?? parameter.name) === name;
    })?.constraint;
    if (bound !== undefined) {
      return bound?.type === 'TSTypeReference' && EVENT_MAP_NAME.test(nameOf(bound));
    }
  }
  return false;
}

/** Whether a rest's type is an event's values, `E[K]` or `RouterServerEventMap[K]`, judged at the map. */
function isEventValues(rest, type) {
  if (type.type !== 'TSIndexedAccessType' || type.objectType.type !== 'TSTypeReference') {
    return false;
  }
  const name = nameOf(type.objectType);
  return EVENT_MAP_NAME.test(name) || isEventMapParameter(rest, name);
}

/** The tuple aliases a file declares at its top, by name: what a rest they type is judged at. */
function tupleAliasesOf(program) {
  const aliases = new Map();
  for (const statement of program.body) {
    const declaration =
      statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement;
    if (
      declaration?.type === 'TSTypeAliasDeclaration' &&
      declaration.typeAnnotation.type === 'TSTupleType'
    ) {
      aliases.set(declaration.id.name, declaration.typeAnnotation);
    }
  }
  return aliases;
}

/** A tuple's elements as parameters, and a fault for each rest inside it. */
function tupleOf(tuple) {
  const slots = [];
  const faults = [];
  for (const element of tuple.elementTypes) {
    const slot = elementSlotOf(element);
    if (slot === undefined) {
      faults.push({ node: element, message: MESSAGES.rest });
    } else {
      slots.push(slot);
    }
  }
  return { faults, slots };
}

/**
 * The parameters `node` takes, each a slot, and the faults of its rests. A rest tuple counts its
 * elements; an unannotated rest is the signature it implements, a rest of an event's values its
 * event, and a rest of a tuple alias of the file that alias, each judged where it is typed; any
 * other is listed or refused.
 */
function signatureOf(node, scope) {
  const slots = [];
  const faults = [];

  for (const param of node.params) {
    if (param.type === 'Identifier' && param.name === 'this') {
      continue;
    }
    if (param.type !== 'RestElement') {
      slots.push(slotOf(param));
      continue;
    }

    const type = param.typeAnnotation?.typeAnnotation;
    if (type === undefined || type === null || isEventValues(param, type)) {
      continue;
    }
    if (type.type === 'TSTupleType') {
      const tuple = tupleOf(type);
      slots.push(...tuple.slots);
      faults.push(...tuple.faults);
      continue;
    }
    if (type.type === 'TSTypeReference' && scope.tuples.has(nameOf(type))) {
      scope.judgeAlias(nameOf(type));
      continue;
    }
    const key = `${ownerOf(node)}(...${scope.context.sourceCode.getText(type)})`;
    if (!Object.hasOwn(LISTED_RESTS, key)) {
      faults.push({ node: param, message: `${MESSAGES.rest}: \`${key}\`` });
    }
  }

  return { faults, slots };
}

// ── The verdicts ─────────────────────────────────────────────────────────────

/** Whether a slot is the options object, which places it: a type that names them, or an optional object. */
function isOptions(slot) {
  return namesOptions(slot.type) || (slot.isObject && slot.isOptional);
}

/** What is wrong with the slot at `index` of `slots`, if anything: the first fault it has. */
function faultOf(slots, index) {
  const slot = slots[index];
  if (index === 3) {
    return MESSAGES.fourth;
  }
  if (index > 3) {
    return undefined;
  }
  if (index === 2 && !slot.isObject) {
    return MESSAGES.third;
  }
  if (isOptions(slot) && index < slots.length - 1) {
    return MESSAGES.notLast;
  }
  if (isOptions(slot) && slots.slice(0, index).some(isOptions)) {
    return MESSAGES.second;
  }
  if (slot.isObject && slot.isOptional && hasRequiredMember(slot.type)) {
    return MESSAGES.optionalOfRequired;
  }
  return undefined;
}

/** Every fault of a signature's slots, each at its slot. */
function slotFaults(slots) {
  return slots.flatMap((slot, index) => {
    const message = faultOf(slots, index);
    return message === undefined ? [] : [{ node: slot.node, message }];
  });
}

function judgeSignature(node, scope) {
  const { faults, slots } = signatureOf(node, scope);
  for (const fault of [...faults, ...slotFaults(slots)]) {
    scope.context.report(fault);
  }
}

/** An event map's events, each a tuple of at most two values. */
function judgeEventMap(node, context) {
  const name = node.id.name;
  const members =
    node.type === 'TSInterfaceDeclaration' ? node.body.body : node.typeAnnotation.members;
  if (!EVENT_MAP_NAME.test(name) || members === undefined) {
    return;
  }
  for (const member of members) {
    const type = member.typeAnnotation?.typeAnnotation;
    if (member.type !== 'TSPropertySignature' || type?.type !== 'TSTupleType') {
      continue;
    }
    const isUnbounded = type.elementTypes.some((element) => {
      return element.type === 'TSRestType';
    });
    if (isUnbounded || type.elementTypes.length > 2) {
      context.report({ node: member, message: MESSAGES.event });
    }
  }
}

// ── The plugin ───────────────────────────────────────────────────────────────

const optionsLast = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Two parameters, then at most one options object, always last (decision 0007).',
    },
    schema: [],
  },
  create(context) {
    const scope = {
      context,
      judged: new Set(),
      tuples: new Map(),
      // a tuple alias typing a rest, judged once, where it is written
      judgeAlias: (name) => {
        if (!scope.judged.has(name)) {
          scope.judged.add(name);
          const tuple = tupleOf(scope.tuples.get(name));
          for (const fault of [...tuple.faults, ...slotFaults(tuple.slots)]) {
            context.report(fault);
          }
        }
      },
    };
    const judge = (node) => {
      judgeSignature(node, scope);
    };
    const judgeMap = (node) => {
      judgeEventMap(node, context);
    };
    return {
      Program: (node) => {
        scope.judged = new Set();
        scope.tuples = tupleAliasesOf(node);
      },
      ArrowFunctionExpression: judge,
      FunctionDeclaration: judge,
      FunctionExpression: judge,
      TSCallSignatureDeclaration: judge,
      TSConstructSignatureDeclaration: judge,
      TSConstructorType: judge,
      TSDeclareFunction: judge,
      TSEmptyBodyFunctionExpression: judge,
      TSFunctionType: judge,
      TSMethodSignature: judge,
      TSInterfaceDeclaration: judgeMap,
      TSTypeAliasDeclaration: judgeMap,
    };
  },
};

// ── The modules a wire format's numbers stand in ─────────────────────────────

/** The package's folder, which a table's path and a module's are given from. */
const PACKAGE = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The table the modules are read from by default, from the package's folder. */
const WIRE_TABLE = '../../tools/wire-names.tsv';

/** The TypeScript column of a row of the table: format, concept, standard, value, then it. */
const TYPESCRIPT_COLUMN = 4;

/** A path as two spellings of it compare: one separator, and Windows's case folded. */
function keyOfPath(path) {
  const key = resolve(path).replaceAll('\\', '/');
  return process.platform === 'win32' ? key.toLowerCase() : key;
}

/**
 * The modules a table's TypeScript column names, each from the repository's root, holders and
 * readers alike: a cell that opens with `-` is a reason, any other its paths by `, `, each before
 * its `#`.
 */
export function tableModulesOf(text) {
  const modules = new Set();
  for (const line of text.split('\n')) {
    if (line.trim() === '' || line.startsWith('#')) {
      continue;
    }
    const cell = line.replace(/\r$/u, '').split('\t')[TYPESCRIPT_COLUMN]?.trim() ?? '';
    if (cell === '' || cell.startsWith('-')) {
      continue;
    }
    for (const entry of cell.split(', ')) {
      modules.add(entry.split('#')[0].trim());
    }
  }
  return [...modules];
}

/**
 * The keys of the modules the rule holds: those `modules` gives from the package's folder, or else
 * those the table at `table` names, the repository's root being the folder its `tools/` sits in.
 * It throws on a table or a module missing, or on no module at all, so that a rule holding nothing
 * fails the lint rather than passes it.
 */
export function wireModulesOf({ modules, table = WIRE_TABLE } = {}) {
  let paths;
  if (modules === undefined) {
    const tablePath = resolve(PACKAGE, table);
    if (!existsSync(tablePath)) {
      throw new Error(`bead/wire-literal: no table at ${tablePath}`);
    }
    const root = resolve(dirname(tablePath), '..');
    paths = tableModulesOf(readFileSync(tablePath, 'utf8')).map((path) => {
      return resolve(root, path);
    });
  } else {
    paths = modules.map((path) => {
      return resolve(PACKAGE, path);
    });
  }
  if (paths.length === 0) {
    throw new Error('bead/wire-literal: the table names no TypeScript module');
  }
  const missing = paths.filter((path) => {
    return !existsSync(path);
  });
  if (missing.length > 0) {
    throw new Error(
      `bead/wire-literal: a module the table names is missing: ${missing.join(', ')}`
    );
  }
  return new Set(paths.map(keyOfPath));
}

// each configuration's modules, read once a run
const WIRE_MODULES = new Map();

function wireModulesFor(options) {
  const key = JSON.stringify(options ?? {});
  if (!WIRE_MODULES.has(key)) {
    WIRE_MODULES.set(key, wireModulesOf(options));
  }
  return WIRE_MODULES.get(key);
}

// ── The notation rule ────────────────────────────────────────────────────────

const WIRE_MESSAGES = Object.freeze({
  literal:
    'a hex or binary literal stands in a definition: a module-level `const` named after its standard (decision 0057)',
  operand:
    '`&`, `|` and `^` take no integer literal above 1 outside a definition: name it after its standard (decision 0057)',
});

/** A hex or binary integer literal, a BigInt's among them: `0x80`, `0b0010`, `0xffn`. */
const HEX_OR_BINARY = /^0[xb]/iu;

/** The bitwise operators the rule holds, compound forms included; a shift is review's. */
const BITWISE = new Set(['&', '|', '^', '&=', '|=', '^=']);

const FUNCTIONS = new Set(['ArrowFunctionExpression', 'FunctionDeclaration', 'FunctionExpression']);

/**
 * Whether `node` stands in a definition: a module-level `const` whose name opens with a capital, a
 * frozen object's members included, with no function between it and the declaration.
 */
function isInDefinition(node) {
  for (let at = node.parent; at !== undefined && at !== null; at = at.parent) {
    if (FUNCTIONS.has(at.type)) {
      return false;
    }
    if (at.type === 'VariableDeclarator') {
      const declaration = at.parent;
      const holder =
        declaration.parent?.type === 'ExportNamedDeclaration'
          ? declaration.parent.parent
          : declaration.parent;
      return (
        declaration.kind === 'const' &&
        holder?.type === 'Program' &&
        at.id.type === 'Identifier' &&
        /^[A-Z]/u.test(at.id.name)
      );
    }
  }
  return false;
}

/** Whether `node` is an integer literal above 1, a BigInt's among them, its parentheses aside. */
function isLiteralAboveOne(node) {
  let at = node;
  while (at?.type === 'ParenthesizedExpression') {
    at = at.expression;
  }
  if (at?.type !== 'Literal') {
    return false;
  }
  if (typeof at.bigint === 'string') {
    return BigInt(at.bigint) > 1n;
  }
  return typeof at.value === 'number' && Number.isInteger(at.value) && at.value > 1;
}

const wireLiteral = {
  meta: {
    type: 'problem',
    docs: {
      description:
        "A wire format's numbers stand in definitions named after their standard (decision 0057).",
    },
    schema: [
      {
        type: 'object',
        properties: {
          modules: { type: 'array', items: { type: 'string' } },
          table: { type: 'string' },
        },
        additionalProperties: false,
      },
    ],
  },
  create(context) {
    const modules = wireModulesFor(context.options[0]);
    if (!modules.has(keyOfPath(context.filename))) {
      return {};
    }
    const judgeOperands = (node, operands) => {
      if (BITWISE.has(node.operator) && operands.some(isLiteralAboveOne) && !isInDefinition(node)) {
        context.report({ node, message: WIRE_MESSAGES.operand });
      }
    };
    return {
      Literal: (node) => {
        if (
          typeof node.raw === 'string' &&
          HEX_OR_BINARY.test(node.raw) &&
          (typeof node.value === 'number' || typeof node.bigint === 'string') &&
          !isInDefinition(node)
        ) {
          context.report({ node, message: WIRE_MESSAGES.literal });
        }
      },
      BinaryExpression: (node) => {
        judgeOperands(node, [node.left, node.right]);
      },
      AssignmentExpression: (node) => {
        judgeOperands(node, [node.right]);
      },
    };
  },
};

export default {
  meta: { name: 'bead' },
  rules: { 'options-last': optionsLast, 'wire-literal': wireLiteral },
};
