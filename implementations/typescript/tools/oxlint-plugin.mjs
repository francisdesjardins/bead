// The lint's own rules, an oxlint JS plugin named `bead`, which `.oxlintrc.base.json` loads.
//
// `bead/options-last` holds the parameter rule (decision 0007): a function takes at most two
// parameters, then at most one options object, always last, optional when every member is and
// required when one is; an event carries at most two values. `max-params` counts the parameters
// written; this judges what a third may be, and counts where `max-params` does not read: a rest
// tuple, a type's signature, an event map.
//
// It reads syntax alone, never what a name resolves to: a callback type aliased under a name ending
// in `Options` passes as an options object, and stays review's (decision 0006), as the one optional
// positional where no second could come does. `oxlint-plugin.cases.ts` beside it holds a line for
// each verdict, and `check-oxlint-plugin.mjs` fails unless exactly its marked lines are refused.

// ── Known exceptions ─────────────────────────────────────────────────────────

/**
 * The rests of any count, as `owner(...type)`: the declarations that hold one, outermost first, and
 * its type as written. Each reason says where the values it stands for are judged.
 */
const LISTED_RESTS = Object.freeze({
  'IBoundCall(...Options)':
    "a call's options, one element: `RequestOptionsParameters`, its default, or a registration's `Pick` of `IRequestOptions`",
  'createServiceServer(...ServiceServerOptions<S>)':
    "a server side's options, one element, required when a procedure names a hook",
  'EmitterListener(...P)': "an event's values, judged at its map",
  'INotificationContext.named(...never[])':
    'the bound of any callable, which a function named after its procedure keeps whole',
  'nameAfter(...never[])':
    'the bound of any callable, which a function named after its procedure keeps whole',
  // the tests'
  'batch(...Uint8Array[])': 'a batch of envelopes, as many as a case puts in it',
  'batchOf(...Uint8Array[])': 'a batch of envelopes, as many as a case puts in it',
  'createFakeHTTPServer.createServer.on(...never[])': 'a fake taking a listener of any event',
  'createFakeHTTPServer.createServer.on(...unknown[])': 'that listener, handed to its emitter',
  'createFakeSocket.socket.on(...never[])': 'a fake taking a listener of any event',
  'createFakeSocket.socket.on(...unknown[])': 'that listener, handed to its emitter',
  'IFakeSocket.hear(...unknown[])':
    "an event a fake socket hears, and its values, as `ws`'s socket emits them",
});

/** The events of three values, as `map.event`: each goes with the decision on such events (0007). */
const LISTED_EVENTS = Object.freeze({
  'SessionManagerEventMap.connectionInactivityTimeoutChanged': 'a session, its new value, its old',
  'SessionManagerEventMap.dataChanged': 'a session, its new data, its old',
  'SessionManagerEventMap.lastActivityChanged': 'a session, its new value, its old',
  'SessionManagerEventMap.sessionInactivityTimeoutChanged': 'a session, its new value, its old',
  'TransportServerEventMap.connection': 'a socket, the request that opened it, its handle',
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

/** An event map's events, each a tuple of at most two values, but the ones listed. */
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
    const key = `${name}.${member.key.name ?? member.key.value}`;
    if ((isUnbounded || type.elementTypes.length > 2) && !Object.hasOwn(LISTED_EVENTS, key)) {
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

export default { meta: { name: 'bead' }, rules: { 'options-last': optionsLast } };
