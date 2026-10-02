import { expect } from '@playwright/test';
import type { IServer } from '../types';

// what a registration keeps on purpose, whether its connection stands or not
const KEPT: ReadonlySet<string> = new Set(['closedDestinations', 'destinations']);

// what each layer still keeps, each as `layer:count value`
const keptOf = (server: Pick<IServer, 'gauges'>): string[] => {
  return Object.entries(server.gauges()).flatMap(([layer, { counts }]) => {
    return Object.entries(counts)
      .filter(([name, count]) => {
        return count !== 0 && !KEPT.has(name);
      })
      .map(([name, count]) => {
        return `${layer}:${name} ${String(count)}`;
      });
  });
};

/**
 * Waits until each layer of `server` keeps nothing — its destinations aside, which a registration
 * keeps on purpose — then expects its health to pass: an end-to-end test ends on it once its clients
 * are gone, so a leak fails it.
 */
export const expectAtRest = async (server: Pick<IServer, 'gauges' | 'health'>): Promise<void> => {
  await expect
    .poll(() => {
      return keptOf(server);
    })
    .toEqual([]);
  expect(server.health().status).toBe('pass');
};
