// dependencies

import { registerToDevtools, type IDevtoolsSource } from '../../client/devtools-hook';
import type { IBrokerParticipant } from './broker-participant';
import { participantHexOf } from './participant-debug';

// definition

/** Announces one participant, with no transport, adapter or capability in its source. @internal */
export const announceParticipantToDevtools = (participant: IBrokerParticipant): (() => void) => {
  return registerToDevtools(
    Object.freeze<IDevtoolsSource>({
      protocol: 1,
      side: 'participant',
      exposition: () => {
        return undefined;
      },
      inspect: () => {
        const { counts, ceilings, anomalies } = participant.gauges();
        return {
          id: participant.id,
          inbox: [participant.root, 'i', participant.id],
          incarnation:
            participant.incarnation === undefined
              ? undefined
              : participantHexOf(participant.incarnation),
          isLinked: participant.isLinked,
          names: [...participant.names],
          gauges: { counts, ceilings, anomalies },
        };
      },
      watch: ({ participant: listener }) => {
        if (listener === undefined) {
          return () => {};
        }
        const hear: typeof listener = (event) => {
          listener(event);
        };
        participant.on('debug', hear);
        return () => {
          participant.off('debug', hear);
        };
      },
    })
  );
};
