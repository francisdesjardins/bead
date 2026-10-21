import { expect, test } from '@playwright/test';
import { ProgrammerError } from '../../transport/shared/errors';
import { type HttpPayload, type IHttpRouteInit, routeOf } from '../routes';
import { TranscodingProcedures } from './generated/transcoding_bead';
import { BookSchema, GetBookRequestSchema, TickSchema } from './generated/transcoding_pb';

// constants

const GET_BOOK: IHttpRouteInit = {
  failures: { REFUSED: 1 },
  procedure: TranscodingProcedures.getBook,
  request: GetBookRequestSchema,
  result: BookSchema,
  routes: [{ method: 'GET', template: '/v1/{name=shelves/*/books/*}' }],
};

// helpers

/** What `routeOf` throws of `init`, its message. */
const refusalOf = (init: IHttpRouteInit): string | undefined => {
  try {
    routeOf(init);
  } catch (error) {
    if (error instanceof ProgrammerError) {
      return error.message;
    }

    throw error;
  }

  return undefined;
};

// tests

test('freezes a route, its routes and each of them, as the table writes it', () => {
  const route = routeOf({ ...GET_BOOK, request: 'json', result: 'raw' });

  expect(route.request).toBe('json');
  expect(Object.isFrozen(route)).toBe(true);
  expect(Object.isFrozen(route.routes)).toBe(true);
  expect(Object.isFrozen(route.routes[0])).toBe(true);
  expect(route.routes[0]).toEqual({ method: 'GET', template: '/v1/{name=shelves/*/books/*}' });
});

test('refuses a payload of no schema nor encoding, a notification only one side has, and a route of no method or no template', () => {
  expect(refusalOf({ ...GET_BOOK, request: 'binary' as HttpPayload })).toBe(
    "getBook's request and result are a message's schema, json, text or raw"
  );
  expect(refusalOf({ ...GET_BOOK, result: null as unknown as HttpPayload })).toBe(
    "getBook's request and result are a message's schema, json, text or raw"
  );
  expect(refusalOf({ ...GET_BOOK, notification: TickSchema })).toBe(
    "getBook's notification is its route's exactly where it notifies"
  );
  expect(
    refusalOf({
      ...GET_BOOK,
      notification: undefined,
      procedure: TranscodingProcedures.ticks,
    })
  ).toBe("ticks's notification is its route's exactly where it notifies");
  expect(
    refusalOf({
      ...GET_BOOK,
      notification: 'binary' as HttpPayload,
      procedure: TranscodingProcedures.ticks,
    })
  ).toBe("ticks's notification is a message's schema, json, text or raw");
  expect(
    refusalOf({
      ...GET_BOOK,
      routes: [{ method: 'CUSTOM' as 'GET', template: '/v1/books' }],
    })
  ).toBe("getBook's route is a method of http.proto's and a template");
  expect(
    refusalOf({
      ...GET_BOOK,
      routes: [{ method: 'GET', template: undefined as unknown as string }],
    })
  ).toBe("getBook's route is a method of http.proto's and a template");
  expect(
    refusalOf({ ...GET_BOOK, notification: TickSchema, procedure: TranscodingProcedures.ticks })
  ).toBeUndefined();
});
