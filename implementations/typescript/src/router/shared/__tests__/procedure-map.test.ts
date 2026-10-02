import { expect, test } from '@playwright/test';
import { createProcedureMap } from '../procedure-map';

// helpers

const echo = { procedureId: 1, serviceId: 2 };
const news = { procedureId: 5, serviceId: 2 };
const other = { procedureId: 1, serviceId: 3 };

// definition

test.describe('createProcedureMap', () => {
  test('keeps one value per procedure, by its service and its own number', () => {
    const procedures = createProcedureMap<string>();

    procedures.set(echo, 'echo');
    procedures.set(news, 'news');
    procedures.set(other, 'other');
    procedures.set({ ...echo }, 'echo again');

    expect([procedures.get(echo), procedures.get(news), procedures.get(other)]).toEqual([
      'echo again',
      'news',
      'other',
    ]);
    expect(procedures.get({ procedureId: 7, serviceId: 2 })).toBeUndefined();
    expect([procedures.has(news), procedures.has({ procedureId: 5, serviceId: 3 })]).toEqual([
      true,
      false,
    ]);
    expect(procedures.values()).toEqual(['echo again', 'news', 'other']);
  });

  test('a service leaves with its last procedure', () => {
    const procedures = createProcedureMap<string>();

    procedures.set(echo, 'echo');
    procedures.set(news, 'news');

    expect(procedures.delete(echo)).toBe(true);
    expect(procedures.hasService(2)).toBe(true);
    expect(procedures.delete(echo)).toBe(false);
    expect(procedures.delete(other)).toBe(false);
    expect(procedures.delete(news)).toBe(true);
    expect(procedures.hasService(2)).toBe(false);
  });

  test('clear forgets every procedure of every service', () => {
    const procedures = createProcedureMap<string>();

    procedures.set(echo, 'echo');
    procedures.set(other, 'other');
    procedures.clear();

    expect([procedures.hasService(2), procedures.hasService(3), procedures.values()]).toEqual([
      false,
      false,
      [],
    ]);
  });
});
