import { IDS, TRAFFIC } from '../../__tests__/traffic';
import { createCallBook, type ICall, type ICallBook } from '../calls';

// The traffic, taken into a book, and its calls by what each shows.

// definition

/** A book of the traffic. */
export const trafficBook = (): ICallBook => {
  const book = createCallBook();

  for (const record of TRAFFIC) {
    book.take(record);
  }

  return book;
};

/** A call of the traffic's, by its id or, for one refused before its id was drawn, by its name. */
export const trafficCall = (which: keyof typeof IDS | 'read'): ICall => {
  const call = trafficBook().calls.find((held) => {
    return which === 'read'
      ? held.callId === undefined && held.procedureName === 'read'
      : held.callId === IDS[which];
  });

  if (call === undefined) {
    throw new Error(`the traffic has no ${which}`);
  }

  return call;
};
