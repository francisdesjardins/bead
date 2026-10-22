// ── Form ──────────────────────────────────────────────────────────────────────

// A blueprint's one form (decision 0022): its members in RFC 8785's order, by their names' UTF-16
// code units, its strings escaped as RFC 8785 escapes them, two spaces, a final line feed, UTF-8
// without a byte order mark; its arrays sorted by identity, as spec/check.py sorts them. Which
// `JSON.stringify` writes as Python's `json.dumps(sort_keys=True, indent=2, ensure_ascii=False)`
// does, escape for escape.

// types

/** What sorts an array: its value's key, compared as numbers, then as strings. */
type SortKey = (item: unknown) => readonly (number | string)[];

/** An array the form sorts, at its place, with what sorts it. */
interface ISortedArray {
  readonly pointer: string;
  readonly items: unknown[];
  readonly key: SortKey;
}

/** How a text departs from its form, the first difference named. */
export interface IFormDifference {
  /** A JSON Pointer, for an array out of its order; none for the text's own layout. */
  readonly pointer?: string;
  /** The line the difference is on, from 1. */
  readonly line?: number;
  readonly message: string;
}

// constants

// a name its catalogue lacks sorts after every code, by its name, as spec/check.py sorts it
const PAST_EVERY_CODE = 65_536;
const BYTE_ORDER_MARK = '\uFEFF';

// helpers

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
};

const arrayAt = (holder: unknown, key: string): unknown[] => {
  const value = isRecord(holder) ? holder[key] : undefined;

  return Array.isArray(value) ? value : [];
};

const memberOf = (item: unknown, key: string): number | string => {
  const value = isRecord(item) ? item[key] : undefined;

  return typeof value === 'number' || typeof value === 'string' ? value : '';
};

const byName: SortKey = (item) => {
  return [typeof item === 'string' ? item : ''];
};

const byRange: SortKey = (item) => {
  return [memberOf(item, 'first'), memberOf(item, 'last')];
};

const byMember = (key: string): SortKey => {
  return (item) => {
    return [memberOf(item, key)];
  };
};

const compareKeys = (
  one: readonly (number | string)[],
  other: readonly (number | string)[]
): number => {
  for (let index = 0; index < Math.max(one.length, other.length); index += 1) {
    const left = one[index] ?? '';
    const right = other[index] ?? '';

    if (typeof left === 'number' && typeof right === 'number') {
      if (left !== right) {
        return left - right;
      }
    } else if (String(left) !== String(right)) {
      return String(left) < String(right) ? -1 : 1;
    }
  }

  return 0;
};

// each array the form sorts, by its place: files by path, messages and enums by full name, a
// message's fields and its rules' fields by number and its oneofs by index, services by id,
// procedures by id, failures by code, a procedure's failures in their codes' order, ranges
// ascending, names in their code points' order; a rule's own lists, `in` and a message's `oneof`, an
// enum's values and a procedure's HTTP rules keep the order their `.proto` writes
const arraysOf = (blueprint: unknown): ISortedArray[] => {
  const arrays: ISortedArray[] = [
    { pointer: '/requires', items: arrayAt(blueprint, 'requires'), key: byName },
  ];
  const proto = isRecord(blueprint) ? blueprint['proto'] : undefined;

  if (proto !== undefined) {
    const messages = arrayAt(proto, 'messages');

    arrays.push(
      { pointer: '/proto/files', items: arrayAt(proto, 'files'), key: byMember('path') },
      { pointer: '/proto/messages', items: messages, key: byMember('fullName') },
      { pointer: '/proto/enums', items: arrayAt(proto, 'enums'), key: byMember('fullName') }
    );

    messages.forEach((message, at) => {
      const rules = isRecord(message) ? message['rules'] : undefined;

      arrays.push({
        pointer: `/proto/messages/${String(at)}/fields`,
        items: arrayAt(message, 'fields'),
        key: byMember('fieldNumber'),
      });

      if (rules !== undefined) {
        arrays.push(
          {
            pointer: `/proto/messages/${String(at)}/rules/fields`,
            items: arrayAt(rules, 'fields'),
            key: byMember('fieldNumber'),
          },
          {
            pointer: `/proto/messages/${String(at)}/rules/oneofs`,
            items: arrayAt(rules, 'oneofs'),
            key: byMember('oneofIndex'),
          }
        );
      }
    });
  }

  const reservedServices = isRecord(blueprint) ? blueprint['reservedServices'] : undefined;
  const services = arrayAt(blueprint, 'services');

  arrays.push(
    { pointer: '/reservedServices/ids', items: arrayAt(reservedServices, 'ids'), key: byRange },
    { pointer: '/reservedServices/names', items: arrayAt(reservedServices, 'names'), key: byName },
    { pointer: '/services', items: services, key: byMember('serviceId') }
  );

  services.forEach((service, index) => {
    const failures = arrayAt(service, 'failures');
    const codes = new Map(
      failures.map((failure) => {
        return [memberOf(failure, 'failureName'), memberOf(failure, 'code')];
      })
    );
    const reserved = isRecord(service) ? service['reserved'] : undefined;
    const place = `/services/${String(index)}`;
    const procedures = arrayAt(service, 'procedures');

    arrays.push(
      { pointer: `${place}/failures`, items: failures, key: byMember('code') },
      {
        pointer: `${place}/reserved/procedureIds`,
        items: arrayAt(reserved, 'procedureIds'),
        key: byRange,
      },
      {
        pointer: `${place}/reserved/procedureNames`,
        items: arrayAt(reserved, 'procedureNames'),
        key: byName,
      },
      {
        pointer: `${place}/reserved/failureCodes`,
        items: arrayAt(reserved, 'failureCodes'),
        key: byRange,
      },
      { pointer: `${place}/procedures`, items: procedures, key: byMember('procedureId') }
    );

    procedures.forEach((procedure, at) => {
      arrays.push({
        pointer: `${place}/procedures/${String(at)}/failures`,
        items: arrayAt(procedure, 'failures'),
        key: (name) => {
          const code = typeof name === 'string' ? codes.get(name) : undefined;

          return [
            typeof code === 'number' ? code : PAST_EVERY_CODE,
            typeof name === 'string' ? name : '',
          ];
        },
      });
    });
  });

  return arrays;
};

const isSorted = (array: ISortedArray): boolean => {
  return array.items.every((item, index) => {
    return index === 0 || compareKeys(array.key(array.items[index - 1]), array.key(item)) <= 0;
  });
};

// a copy whose members are in RFC 8785's order, by their names' UTF-16 code units
const withSortedMembers = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(withSortedMembers);
  }

  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => {
          return [key, withSortedMembers(value[key])];
        })
    );
  }

  return value;
};

// definition

/** A copy of `blueprint` whose every array is in its order. */
export const sortedOf = <T>(blueprint: T): T => {
  const copy = structuredClone(blueprint);

  for (const array of arraysOf(copy)) {
    array.items.sort((one, other) => {
      return compareKeys(array.key(one), array.key(other));
    });
  }

  return copy;
};

/**
 * `value` in the blueprint's own form but for its arrays, which keep their order: its members in RFC
 * 8785's order, two spaces, a final line feed, as the OpenAPI document is written (decision 0037).
 */
export const membersSortedTextOf = (value: unknown): string => {
  return `${JSON.stringify(withSortedMembers(value), null, 2)}\n`;
};

/** `blueprint` written in its form: its arrays sorted, its members ordered, two spaces, a final line feed. */
export const formOf = (blueprint: unknown): string => {
  return `${JSON.stringify(withSortedMembers(sortedOf(blueprint)), null, 2)}\n`;
};

/** `blueprint` without what a front end read of a `.proto`: what a blueprint written by hand holds. */
export const projectionOf = <T>(blueprint: T): T => {
  const copy = structuredClone(blueprint);

  if (isRecord(copy)) {
    Reflect.deleteProperty(copy, 'proto');

    for (const service of arrayAt(copy, 'services')) {
      if (isRecord(service)) {
        Reflect.deleteProperty(service, 'proto');
      }
    }
  }

  return copy;
};

/**
 * How `text`, a blueprint's whole text, a byte order mark included, departs from `blueprint`'s form,
 * as spec/check.py names it: a byte order mark; each array out of its order; else the first line
 * off, or a last line with no line feed. None when the text is its form.
 */
export const formDifferencesOf = (text: string, blueprint: unknown): readonly IFormDifference[] => {
  const differences: IFormDifference[] = [];
  const body = text.startsWith(BYTE_ORDER_MARK) ? text.slice(BYTE_ORDER_MARK.length) : text;

  if (body !== text) {
    differences.push({
      line: 1,
      message: 'it opens with a byte order mark, which its form never writes',
    });
  }

  for (const array of arraysOf(blueprint)) {
    if (!isSorted(array)) {
      differences.push({ pointer: array.pointer, message: 'out of its order' });
    }
  }

  const form = formOf(blueprint);

  if (differences.length > 0 || body === form) {
    return differences;
  }

  const written = body.split('\n');
  const formed = form.split('\n');
  const shorter = Math.min(written.length, formed.length);
  let line = 0;

  while (line < shorter && written[line] === formed[line]) {
    line += 1;
  }

  if (line === shorter && written.length < formed.length) {
    return [{ line: written.length, message: 'its last line ends with no line feed' }];
  }

  const carriageReturn =
    written[line]?.endsWith('\r') === true ? ', a carriage return its form never writes' : '';

  return [{ line: line + 1, message: `line ${String(line + 1)} is off its form${carriageReturn}` }];
};
