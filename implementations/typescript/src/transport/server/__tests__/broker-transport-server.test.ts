// dependencies

import { expect, test } from '@playwright/test';
import { createRouterClient } from '../../../router/client/router-client';
import { FailureError } from '../../../router/server/router-server';
import { createRouterServer } from '../../../router/server/router-server';
import { CredentialScheme, ProtocolCode } from '../../../router/shared/constants';
import { PAYLOAD_CODECS } from '../../../router/shared/payloads';
import { createServiceManager } from '../../../router/shared/service-manager';
import type { IProcedure } from '../../../router/shared/types';
import { createBrokerParticipant } from '../../shared/broker-participant';
import { ProgrammerError } from '../../shared/errors';
import { createMemoryBroker } from '../../shared/memory-broker';
import { createTestClock } from '../../shared/__tests__/fixtures';
import {
  ACCEPT_TIMEOUT,
  createBrokerTransportServer,
  MAXIMUM_UNSENT_BYTES,
} from '../broker-transport-server';
import type { TransportServerConnectionHandle } from '../types';

// constants

const echo: IProcedure = {
  procedureId: 1,
  procedureName: 'echo',
  serviceId: 2,
  serviceRevision: 1,
};

// helpers

/** A turn of the event loop, past what the broker handed on in a later one. */
const turn = (): Promise<void> => {
  return new Promise(setImmediate);
};

// definition

test.describe('createBrokerTransportServer', () => {
  test('draws a handle of its adapter type for each connection at its third leg, and gives none twice', async () => {
    const clock = createTestClock(Date.UTC(2026, 9, 26));
    const broker = createMemoryBroker({ clock });
    const participant = createBrokerParticipant({
      adapter: broker.adapter({ id: 'server' }),
      clock,
    });
    const server = participant.transportServer({ names: ['interop'] });
    const ada = createBrokerParticipant({ adapter: broker.adapter({ id: 'ada' }), clock });
    const opened: TransportServerConnectionHandle[] = [];
    const halfOpen: number[] = [];

    server.on('connection', (...[peer, request, connectionHandle]) => {
      expect([peer.id, request]).toEqual(['ada', undefined]);
      opened.push(connectionHandle);
    });

    expect(await server.start()).toEqual({ address: 'server', port: 0 });

    const first = ada.transportClient();
    const second = ada.transportClient();

    // * none told before its client's first parcel naming both halves came
    const connecting = first.connect({ server: 'interop' });

    await Promise.resolve();
    halfOpen.push(server.gauges().counts['halfOpen'] ?? -1);
    await connecting;
    await turn();
    await second.connect({ server: 'interop' });
    await turn();

    expect(opened).toEqual([
      'type=BROKER;participant=ada;ordinal=1',
      'type=BROKER;participant=ada;ordinal=2',
    ]);
    expect(server.clients).toEqual([
      {
        address: 'ada',
        connectionHandle: 'type=BROKER;participant=ada;ordinal=1',
        lastActivity: undefined,
        port: 0,
        type: 'BROKER',
      },
      {
        address: 'ada',
        connectionHandle: 'type=BROKER;participant=ada;ordinal=2',
        lastActivity: undefined,
        port: 0,
        type: 'BROKER',
      },
    ]);

    // a connection closed and another drawn: its handle is a new one
    await first.disconnect();
    await turn();
    await first.connect({ server: 'interop' });
    await turn();

    expect(opened.at(-1)).toBe('type=BROKER;participant=ada;ordinal=3');
    expect(server.isSecure(opened.at(-1) ?? 'type=BROKER;participant=ada;ordinal=3')).toBe(true);
    expect(server.gauges().counts).toMatchObject({ connections: 2, halfOpen: 0, names: 1 });

    // its stop closes each with 1001, its participant's link kept
    await server.stop();
    await turn();

    expect([first.isClosed(), second.isClosed(), participant.isLinked]).toEqual([true, true, true]);

    await Promise.all([participant.stop(), ada.stop()]);

    // its bounds held as it is built
    expect([ACCEPT_TIMEOUT, MAXIMUM_UNSENT_BYTES]).toEqual([30_000, 184_551_424]);

    for (const options of [
      { names: [] },
      { names: ['a.b'] },
      { acceptTimeout: Infinity, names: ['interop'] },
      { maximumConnections: 0, names: ['interop'] },
    ]) {
      expect(() => {
        return createBrokerTransportServer(participant, options);
      }, JSON.stringify(options)).toThrow(ProgrammerError);
    }

    const plain = createBrokerParticipant({
      adapter: broker.adapter({ capabilities: { will: true }, id: 'plain' }),
    });

    expect(() => {
      return plain.transportServer({ group: true, names: ['interop'] });
    }).toThrow(
      'a name served in a group needs an adapter that offers groups, and the adapter of plain does not'
    );
  });

  test('carries no credential toward its client, and its command presenting ELSEWHERE fails before it goes', async () => {
    const broker = createMemoryBroker();
    const participant = createBrokerParticipant({ adapter: broker.adapter({ id: 'server' }) });
    const server = participant.transportServer({ names: ['interop'] });
    const ada = createBrokerParticipant({ adapter: broker.adapter({ id: 'ada' }) });
    const client = ada.transportClient();

    using router = createRouterServer(server);
    using routerClient = createRouterClient(client);

    createServiceManager(routerClient).getRequestResolver(echo, {
      serializer: PAYLOAD_CODECS.text,
    })((request, response) => {
      return response(request.payload);
    });

    await server.start();
    await client.connect({ server: 'interop' });
    await turn();

    const [{ connectionHandle } = { connectionHandle: undefined }] = server.clients;

    expect(
      connectionHandle === undefined ? undefined : server.carriesCredential(connectionHandle)
    ).toBe(false);

    // * refused before it goes: no transport carries one toward its client
    const commanded = await router
      .request(new TextEncoder().encode('hi'), {
        options: {
          connectionHandle: connectionHandle ?? 'type=BROKER;participant=ada;ordinal=1',
          credential: { carried: 'Bearer token', scheme: CredentialScheme.ELSEWHERE },
          timeout: 1_000,
        },
        procedure: echo,
      })
      .then(
        () => {
          return 'answered';
        },
        (reason: unknown) => {
          return reason instanceof FailureError ? reason.code : reason;
        }
      );

    expect(commanded).toBe(ProtocolCode.DESTINATION_UNREACHABLE);

    // one presenting none goes, and its client answers it
    const answered = await router.request(new TextEncoder().encode('hi'), {
      options: {
        connectionHandle: connectionHandle ?? 'type=BROKER;participant=ada;ordinal=1',
        timeout: 1_000,
      },
      procedure: echo,
    });

    expect(new TextDecoder().decode(answered.payload)).toBe('hi');

    await client.disconnect();
    await Promise.all([participant.stop(), ada.stop()]);
  });
});
