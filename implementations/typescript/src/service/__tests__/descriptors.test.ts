import { expect, test } from '@playwright/test';
import { ProcedureKind } from '../../router/shared/constants';
import { PAYLOAD_CODECS } from '../../router/shared/payloads';
import { ProgrammerError } from '../../transport/shared/errors';
import { commandOf, requestOf } from '../descriptors';

// helpers

const { text } = PAYLOAD_CODECS;

const sayHello = {
  admission: 'none',
  failures: {},
  procedure: { procedureId: 1, procedureName: 'sayHello', serviceId: 7, serviceRevision: 1 },
  request: text,
  result: text,
} as const;

// definition

test.describe('the descriptors', () => {
  test("sets a request's kind, a notifying request's and a command's", () => {
    const request = requestOf(sayHello);
    const notifying = requestOf({ ...sayHello, notification: text });
    const command = commandOf(sayHello);

    expect(
      [request, notifying, command].map(({ procedure }) => {
        return procedure.procedureKind;
      })
    ).toEqual([ProcedureKind.REQUEST, ProcedureKind.NOTIFIES, ProcedureKind.COMMAND]);
    expect(Object.isFrozen(request)).toBe(true);
    expect(Object.isFrozen(request.procedure)).toBe(true);
    // * the procedure given stays as it was: the descriptor holds a copy
    expect(Object.hasOwn(sayHello.procedure, 'procedureKind')).toBe(false);
    // the same kind stated, it is taken
    expect(
      commandOf({ ...sayHello, procedure: { ...sayHello.procedure, procedureKind: 'command' } })
        .procedure.procedureKind
    ).toBe(ProcedureKind.COMMAND);
  });

  test('refuses a procedure that states another kind', () => {
    expect(() => {
      return requestOf({
        ...sayHello,
        procedure: { ...sayHello.procedure, procedureKind: 'command' },
      });
    }).toThrow(ProgrammerError);
    expect(() => {
      return requestOf({
        ...sayHello,
        notification: text,
        procedure: { ...sayHello.procedure, procedureKind: 'request' },
      });
    }).toThrow(ProgrammerError);
    expect(() => {
      return commandOf({
        ...sayHello,
        procedure: { ...sayHello.procedure, procedureKind: 'notifies' },
      });
    }).toThrow(ProgrammerError);
  });

  test('refuses a codec missing', () => {
    for (const init of [
      { ...sayHello, request: undefined },
      { ...sayHello, result: { decode: text.decode } },
      { ...sayHello, notification: { encode: text.encode } },
    ]) {
      expect(() => {
        return requestOf(init as never);
      }).toThrow(ProgrammerError);
    }

    // past the types: a command never notifies, a rule is one of three, a validate a function
    expect(() => {
      return commandOf({ ...sayHello, notification: text } as never);
    }).toThrow(ProgrammerError);
    expect(() => {
      return requestOf({ ...sayHello, admission: 'everyone' } as never);
    }).toThrow(ProgrammerError);
    expect(() => {
      return requestOf({ ...sayHello, validate: true } as never);
    }).toThrow(ProgrammerError);
  });
});
