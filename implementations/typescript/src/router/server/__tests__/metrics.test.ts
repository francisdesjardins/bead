// ── Metrics ───────────────────────────────────────────────────────────────────

// Bead's metrics, `spec/metrics.json`, played against the TypeScript side: each exposition on a
// registry alone, through the surface its routers count with, and each exit on the interop
// service's server, given a registry, as `conversations.test.ts` plays a conversation. The C# side
// plays the same file.

// dependencies

import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { ProgrammerError } from '../../../transport/shared/errors';
import { FailureScope, ProtocolCode } from '../../shared/constants';
import {
  CallEnding,
  createMetricsRegistry,
  type IHearingSeries,
  type INotifyingSeries,
  type IProcedureSeries,
  type IRouterMetrics,
} from '../../shared/metrics-registry';
import type { RouterSide } from '../../shared/types';
import { type IConversation, playConversation } from './conversation-player';

// interfaces

interface IDeclaration {
  as: 'notification' | 'requester' | 'resolver';
  notifies?: true;
  procedureId: number;
  procedureName: string;
  refused?: string;
  router: number;
  serviceId: number;
}

/** A count, as the file writes one: a call, a notification, or a subscription dropped. */
interface ICount {
  call?: 'answered' | 'made';
  code?: string;
  dropped?: 'hears' | 'notifies';
  microseconds?: number;
  notification?: 'failed' | 'heard' | 'sent';
  outcome?: string;
  procedureId?: number;
  router: number;
  serviceId?: number;
}

interface IExposition {
  counts: ICount[];
  declarations: IDeclaration[];
  exposition: string[];
  maximumProcedures?: number;
  name: string;
  routers: RouterSide[];
}

/** What one router's declarations gave, by what was declared and its address. */
interface IDeclared {
  hearing: Map<string, IHearingSeries>;
  made: Map<string, IProcedureSeries>;
  answered: Map<string, IProcedureSeries>;
  notifying: Map<string, INotifyingSeries>;
}

// constants

const {
  exits: EXITS,
  expositions: EXPOSITIONS,
  mediaType: MEDIA_TYPE,
} = JSON.parse(
  readFileSync(new URL('../../../../../../spec/metrics.json', import.meta.url), 'utf8')
) as { exits: IConversation[]; expositions: IExposition[]; mediaType: string };

// each reason of the file, by how the TypeScript side's refusal ends
const REASONS: readonly string[] = [
  'another name at its address',
  'its name at another address',
  'past the ceiling',
];

// the endings of a call besides a failure, by its outcome
const ENDINGS: Readonly<Record<string, number>> = Object.freeze({
  cancelled: CallEnding.CANCELLED,
  closed: CallEnding.CLOSED,
  error: CallEnding.ERROR,
  result: CallEnding.RESULT,
  timeout: CallEnding.TIMEOUT,
});

// a code section 8 names none of, which a failure may carry all the same
const UNNAMED_CODE = 99;

// helpers

/** The failure a count's code stands for: a protocol code by its name, the application's, or none. */
const failureOf = (code: string): { code: number; scope: FailureScope } => {
  if (code === 'application') {
    return { code: 7, scope: FailureScope.APPLICATION };
  }

  return {
    code: code === '_OTHER' ? UNNAMED_CODE : ProtocolCode[code as keyof typeof ProtocolCode],
    scope: FailureScope.PROTOCOL,
  };
};

/** How a counted call ended, by its outcome and its code. */
const endingOfCount = ({
  code,
  outcome,
}: {
  code: string | undefined;
  outcome: string | undefined;
}): number => {
  if (outcome !== 'failure') {
    return ENDINGS[outcome ?? ''] ?? CallEnding.ERROR;
  }

  const failure = failureOf(code ?? '');

  return failure.scope === FailureScope.APPLICATION
    ? CallEnding.APPLICATION
    : failure.code === UNNAMED_CODE
      ? CallEnding.OTHER
      : failure.code;
};

/** The reason a declaration was refused for, read back from the TypeScript side's sentence. */
const reasonOf = (error: unknown): string | undefined => {
  return error instanceof ProgrammerError
    ? REASONS.find((reason) => {
        return error.message.endsWith(`: ${reason}`);
      })
    : undefined;
};

/** A count played on the routers' surfaces and their declarations. */
const countOn = (
  count: ICount,
  { declared, routers }: { declared: readonly IDeclared[]; routers: readonly IRouterMetrics[] }
): void => {
  const { call, code, dropped, microseconds, notification, outcome, procedureId, serviceId } =
    count;
  const at = `${String(serviceId)}/${String(procedureId)}`;
  const own = declared[count.router] as IDeclared;
  const router = routers[count.router] as IRouterMetrics;

  if (call !== undefined) {
    const series =
      serviceId === undefined
        ? call === 'answered'
          ? router.otherServer
          : router.otherClient
        : (own[call].get(at) as IProcedureSeries);

    series.start();

    if (outcome !== undefined) {
      series.end(endingOfCount({ code, outcome }), microseconds ?? 0);
    }

    return;
  }

  if (notification === 'heard') {
    return (own.hearing.get(at)?.heard(), undefined);
  }

  if (notification !== undefined) {
    const notifying = own.notifying.get(at) as INotifyingSeries;

    return (notification === 'sent' ? notifying.sent() : notifying.failed(), undefined);
  }

  const ending = code === undefined ? undefined : failureOf(code);

  if (dropped === 'hears') {
    own.hearing.get(at)?.dropped(ending);
  } else {
    own.notifying.get(at)?.dropped(ending);
  }
};

// definition

test.describe('the expositions', () => {
  for (const {
    counts,
    declarations,
    exposition,
    maximumProcedures,
    name,
    routers: sides,
  } of EXPOSITIONS) {
    test(name, () => {
      const registry = createMetricsRegistry({ maximumProcedures });
      const routers = sides.map((side) => {
        return registry.attach(side);
      });
      const declared = sides.map((): IDeclared => {
        return { answered: new Map(), hearing: new Map(), made: new Map(), notifying: new Map() };
      });

      for (const [index, declaration] of declarations.entries()) {
        const { as, notifies, procedureId, refused, router, serviceId } = declaration;
        const at = `${String(serviceId)}/${String(procedureId)}`;
        const metrics = routers[router] as IRouterMetrics;
        const own = declared[router] as IDeclared;
        let thrown: unknown;

        try {
          if (as === 'requester') {
            own.made.set(at, metrics.declareRequester(declaration));
          } else if (as === 'notification') {
            own.hearing.set(at, metrics.declareNotification(declaration));
          } else {
            const series = metrics.declareResolver(declaration, { notifies: notifies === true });

            own.answered.set(at, series.calls);

            if (series.notifying !== undefined) {
              own.notifying.set(at, series.notifying);
            }
          }
        } catch (error) {
          thrown = error;
        }

        expect(reasonOf(thrown), `declaration ${String(index + 1)}: ${String(thrown)}`).toBe(
          refused
        );
      }

      for (const count of counts) {
        countOn(count, { declared, routers });
      }

      const written = registry.exposition();

      expect(written.contentType).toBe(MEDIA_TYPE);
      expect(written.text.split('\n').slice(0, -1)).toEqual(exposition);
      expect(written.text).toBe(exposition.length === 0 ? '' : `${exposition.join('\n')}\n`);
    });
  }
});

test.describe('the exits', () => {
  // played once, as the C# side plays them: a retry would hide what fails there
  test.describe.configure({ retries: 0 });

  for (const exit of EXITS) {
    test(exit.name, async () => {
      await playConversation(exit, { metricsRegistry: createMetricsRegistry() });
    });
  }
});
