import { expect, test } from '@playwright/test';
import { ProtocolCode } from '../../router/shared/constants';
import {
  type ICallFailure,
  problemOfFailure,
  problemOfOwn,
  problemOfRefusal,
  PROTOCOL_TYPES,
} from '../problems';
import { EverythingSchema, UpdateBookRequestSchema } from './generated/transcoding_pb';

// helpers

const statusOf = (failure: Omit<ICallFailure, 'scope'>): number => {
  return problemOfFailure({ ...failure, scope: 'protocol' }).status;
};

// tests

test('answers each protocol code with its status by where it arose, and its problem', () => {
  // the caller's, the server's answer the gateway could not take, and between them alone
  expect(statusOf({ arose: 'server', code: ProtocolCode.PAYLOAD_TOO_LARGE })).toBe(413);
  expect(statusOf({ arose: 'client', code: ProtocolCode.ENVELOPE_TOO_LARGE })).toBe(413);
  expect(statusOf({ arose: 'answer', code: ProtocolCode.PAYLOAD_TOO_LARGE })).toBe(502);
  expect(statusOf({ arose: 'gateway', code: ProtocolCode.PAYLOAD_UNDECODABLE })).toBe(400);
  expect(
    statusOf({ arose: 'server', code: ProtocolCode.PAYLOAD_UNDECODABLE, encoding: 'text' })
  ).toBe(400);
  expect(statusOf({ arose: 'server', code: ProtocolCode.PAYLOAD_UNDECODABLE })).toBe(502);
  expect(statusOf({ arose: 'answer', code: ProtocolCode.PAYLOAD_UNDECODABLE })).toBe(502);
  expect(statusOf({ arose: 'server', code: ProtocolCode.LAYOUT_UNSUPPORTED })).toBe(502);
  expect(statusOf({ arose: 'answer', code: ProtocolCode.CALL_UNKNOWN })).toBe(500);
  expect(statusOf({ arose: 'server', code: ProtocolCode.PROCEDURE_UNKNOWN })).toBe(501);
  expect(statusOf({ arose: 'server', code: ProtocolCode.ACCESS_DENIED })).toBe(403);
  expect(statusOf({ arose: 'server', code: ProtocolCode.CREDENTIAL_UNSUPPORTED })).toBe(500);
  expect(statusOf({ arose: 'client', code: ProtocolCode.TRANSFER_STALLED })).toBe(504);
  expect(statusOf({ arose: 'client', code: ProtocolCode.DESTINATION_LOST })).toBe(502);
  expect(statusOf({ arose: 'server', code: 99 })).toBe(500);

  const unreachable = problemOfFailure({
    arose: 'client',
    code: ProtocolCode.DESTINATION_UNREACHABLE,
    detail: 'the connection is gone',
    scope: 'protocol',
  });

  // * the gateway's own error between it and its server: its code alone, whatever its detail
  expect(unreachable).toEqual({
    body: `{"code":17,"scope":"protocol","status":503,"title":"DESTINATION_UNREACHABLE","type":"${PROTOCOL_TYPES}DESTINATION_UNREACHABLE"}`,
    fields: { 'retry-after': '1' },
    status: 503,
  });

  // a 401's challenge, its error after a space, or after `, ` where it holds parameters
  const required = {
    arose: 'server',
    code: ProtocolCode.SESSION_REQUIRED,
    scope: 'protocol',
  } as const;

  expect(problemOfFailure(required).fields).toEqual({ 'www-authenticate': 'Bearer' });
  expect(problemOfFailure({ ...required, credential: true }).fields).toEqual({
    'www-authenticate': 'Bearer error="invalid_token"',
  });
  expect(
    problemOfFailure({ ...required, credential: true }, { challenge: 'Bearer realm="bead"' }).fields
  ).toEqual({ 'www-authenticate': 'Bearer realm="bead", error="invalid_token"' });

  // an application failure, under its problem types or about:blank
  const refused = { arose: 'server', code: 1, detail: 'no', scope: 'application' } as const;

  expect(
    problemOfFailure(refused, { catalogue: { REFUSED: 1 }, problemTypes: 'https://p.example/' })
      .body
  ).toBe(
    '{"code":1,"detail":"no","scope":"application","status":400,"title":"REFUSED","type":"https://p.example/REFUSED"}'
  );
  expect(problemOfFailure(refused).body).toBe(
    '{"code":1,"detail":"no","scope":"application","status":400,"title":"Bad Request","type":"about:blank"}'
  );

  // the gateway's own
  expect(problemOfOwn('timeout', { detail: 'no answer' })).toEqual({
    body: '{"detail":"no answer","status":504,"title":"Gateway Timeout","type":"about:blank"}',
    fields: {},
    status: 504,
  });
  expect(problemOfOwn('scheme', { detail: 'x' }).fields).toEqual({
    'www-authenticate': 'Bearer error="invalid_request"',
  });
  expect(problemOfOwn('jwt', { detail: 'x' }).status).toBe(431);
  expect(problemOfRefusal(404, 'no route').body).toBe(
    '{"detail":"no route","status":404,"title":"Not Found","type":"about:blank"}'
  );
});

test('writes PAYLOAD_INVALID’s violations as errors, each pointer by JSON names', () => {
  const invalid = (detail: string, route: Parameters<typeof problemOfFailure>[1]): unknown => {
    const { body } = problemOfFailure(
      { arose: 'server', code: ProtocolCode.PAYLOAD_INVALID, detail, scope: 'protocol' },
      route
    );

    return JSON.parse(body);
  };
  const lines = [
    '{"fieldPath":"labels[\\"a/b~c dé\\"]","forKey":true,"ruleId":"string.min_len","bounds":{"min_len":"2"}}',
    '{"fieldPath":"inners[1].name","message":"short","ruleId":"string.min_len"}',
    '{"fieldPath":"by_id[-1]","message":"short","ruleId":"string.min_len"}',
    '{"fieldPath":"custom_named","message":"short","ruleId":"string.min_len"}',
    '{"fieldPath":"labels[\\"kk\\"...]","message":"cut","ruleId":"int32.gt"}',
    '{"fieldPath":"choice","message":"one","ruleId":"required"}',
    '{"message":"one of a or b","ruleId":"message.oneof"}',
    '{"more":2}',
  ];

  expect(
    invalid(lines.join('\n'), {
      route: { body: '*', request: EverythingSchema, variables: ['a_string'] },
    })
  ).toEqual({
    code: 52,
    errors: [
      {
        bounds: { min_len: '2' },
        detail: 'must be at least 2 characters',
        fieldPath: 'labels["a/b~c dé"]',
        forKey: true,
        pointer: '#/labels/a~1b~0c%20d%C3%A9',
        ruleId: 'string.min_len',
      },
      {
        detail: 'short',
        fieldPath: 'inners[1].name',
        pointer: '#/inners/1/name',
        ruleId: 'string.min_len',
      },
      { detail: 'short', fieldPath: 'by_id[-1]', pointer: '#/byId/-1', ruleId: 'string.min_len' },
      {
        detail: 'short',
        fieldPath: 'custom_named',
        pointer: '#/renamed',
        ruleId: 'string.min_len',
      },
      { detail: 'cut', fieldPath: 'labels["kk"...]', pointer: '#/labels', ruleId: 'int32.gt' },
      { detail: 'one', fieldPath: 'choice', pointer: '#', ruleId: 'required' },
      { detail: 'one of a or b', pointer: '#', ruleId: 'message.oneof' },
    ],
    more: 2,
    scope: 'protocol',
    status: 422,
    title: 'PAYLOAD_INVALID',
    type: `${PROTOCOL_TYPES}PAYLOAD_INVALID`,
  });

  // under a body of one field, a pointer from it, a variable's and the query's a parameter
  const book = [
    '{"fieldPath":"book.title","message":"short","ruleId":"string.min_len"}',
    '{"fieldPath":"book.name","message":"no name","ruleId":"string.pattern"}',
    '{"fieldPath":"update_mask","message":"value is required","ruleId":"required"}',
    '{"message":"one of a or b","ruleId":"message.oneof"}',
    '{"stopped":true}',
  ];

  expect(
    invalid(book.join('\n'), {
      route: { body: 'book', request: UpdateBookRequestSchema, variables: ['book.name'] },
    })
  ).toMatchObject({
    errors: [
      { pointer: '#/title' },
      { parameter: 'book.name' },
      { parameter: 'updateMask' },
      { detail: 'one of a or b', ruleId: 'message.oneof' },
    ],
    stopped: true,
  });
});

test('places a violation off 18.4’s field path grammar at the body whole, or nowhere under a body of one field, and one below a scalar at that scalar', () => {
  const errorsOf = (detail: string, route?: Parameters<typeof problemOfFailure>[1]): unknown => {
    const { body } = problemOfFailure(
      { arose: 'server', code: ProtocolCode.PAYLOAD_INVALID, detail, scope: 'protocol' },
      route
    );

    return (JSON.parse(body) as { errors: unknown }).errors;
  };
  const violationOf = (fieldPath: string): string => {
    return JSON.stringify({ fieldPath, message: 'm', ruleId: 'string.min_len' });
  };

  expect(
    errorsOf(
      [violationOf('!bad'), violationOf('a_string[0]x'), violationOf('a_string.inner')].join('\n'),
      {
        route: { body: '*', request: EverythingSchema, variables: [] },
      }
    )
  ).toEqual([
    { detail: 'm', fieldPath: '!bad', pointer: '#', ruleId: 'string.min_len' },
    { detail: 'm', fieldPath: 'a_string[0]x', pointer: '#', ruleId: 'string.min_len' },
    { detail: 'm', fieldPath: 'a_string.inner', pointer: '#/aString', ruleId: 'string.min_len' },
  ]);
  expect(
    errorsOf([violationOf('!bad'), violationOf('book.title[0]x')].join('\n'), {
      route: { body: 'book', request: UpdateBookRequestSchema, variables: [] },
    })
  ).toEqual([
    { detail: 'm', fieldPath: '!bad', ruleId: 'string.min_len' },
    { detail: 'm', fieldPath: 'book.title[0]x', ruleId: 'string.min_len' },
  ]);
  // without its route, no violation is placed; without its message, none is told
  expect(errorsOf('{"fieldPath":"a_string","ruleId":"x.y"}')).toEqual([
    { fieldPath: 'a_string', ruleId: 'x.y' },
  ]);
});

test('answers a refusal of a status without a phrase by its number, and one without words with no detail', () => {
  expect(problemOfRefusal(599, '').body).toBe('{"status":599,"title":"599","type":"about:blank"}');
});
