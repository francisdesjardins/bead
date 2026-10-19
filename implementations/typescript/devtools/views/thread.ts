// ── A call's thread, drawn ────────────────────────────────────────────────────

// The Exchange tab's drawing, in SVG, with nothing to load: two lanes, the page and the server, a
// third for a destination behind the server's relay; each envelope an arrow between two lanes and a
// bead on the call's thread, its kind over the arrow and its words under it, from the page's lane,
// its time on the left; and, for a transfer, a bar of the bytes that passed against the credit
// given.

// dependencies

import type { ICall } from '../model/calls';
import { progressOf, transferOf } from '../model/facts';
import { threadOf } from '../model/thread';
import { bytesOf, numberOf, spanOf } from '../model/words';
import { make, noteOf, svgOf } from './dom';

// constants

/** The width the thread is drawn at; the page scales it down to its own. */
const WIDTH = 440;

/** What a label leaves clear before the next lane to its right, and an offset before the page's. */
const MARGIN = 6;

/** Where an exchange's labels start past the page's lane, clear of the arrowhead that ends there. */
const INSET = 8;

/** How far an envelope's words sit under its arrow: their top clear of the largest bead. */
const UNDER = 19;

// definition

/**
 * Cuts an attached thread's labels to the room their `data-room` gives, before the next lane, a
 * label cut keeping its whole text in a tooltip.
 */
export const fitThreadLabels = (root: HTMLElement): void => {
  // * every width is read before a label is cut, so the drawing is laid out once; a character's
  // width is taken as the label's over its length, exact in the words' monospace font
  const cuts = [...root.querySelectorAll<SVGTextElement>('.thread text[data-room]')].map(
    (label) => {
      const content = label.firstChild;
      const room = Number(label.dataset['room']);

      if (!(content instanceof Text) || content.data.length === 0) {
        return undefined;
      }

      const width = label.getComputedTextLength();

      return width <= room
        ? undefined
        : { content, label, length: Math.floor((room / width) * content.data.length) - 1 };
    }
  );

  for (const cut of cuts) {
    if (cut !== undefined) {
      if (cut.label.querySelector('title') === null) {
        cut.label.append(svgOf('title', { text: cut.content.data }));
      }

      cut.content.data = `${cut.content.data.slice(0, Math.max(1, cut.length)).trimEnd()}…`;
    }
  }
};

/** A call's thread, drawn, and what its transfer did. */
export const threadViewOf = (call: ICall, { client }: { client: string }): Node[] => {
  const thread = threadOf(call);
  const isRelayed = thread.destinationId !== undefined;
  const lanes = isRelayed
    ? [WIDTH * 0.1, WIDTH * 0.47, WIDTH * 0.84]
    : [WIDTH * 0.14, WIDTH * 0.84];
  const [page = 0, server = 0, beyond = 0] = lanes;
  const names: [string, string][] = [
    ['page', client],
    [isRelayed ? 'relay' : 'server', isRelayed ? 'the server' : 'its peer'],
    ...(isRelayed
      ? [[`destination ${String(thread.destinationId)}`, 'behind the relay'] as [string, string]]
      : []),
  ];
  const middle = (page + server) / 2;
  const left = page + INSET;
  const parts: SVGElement[] = [];
  const roomOf = (x: number): number => {
    return (
      (lanes.find((lane) => {
        return lane > x;
      }) ?? WIDTH) -
      x -
      MARGIN
    );
  };

  lanes.forEach((x, index) => {
    parts.push(
      svgOf('line', {
        attributes: {
          class: 'life',
          'stroke-dasharray': index === 2 ? '3 3' : undefined,
          x1: x,
          x2: x,
          y1: 34,
          y2: thread.height,
        },
      }),
      svgOf('text', {
        attributes: { class: 'lane', 'text-anchor': 'middle', x, y: 13 },
        text: names[index]?.[0],
      }),
      svgOf('text', {
        attributes: { class: 'lane-sub', 'text-anchor': 'middle', x, y: 26 },
        text: names[index]?.[1],
      })
    );
  });

  if (thread.beads.length > 1) {
    parts.push(
      svgOf('path', {
        attributes: {
          class: 'string',
          d: `M${thread.beads
            .map(({ y }) => {
              return `${String(middle)} ${String(y)}`;
            })
            .join(' L')}`,
        },
      })
    );
  }

  for (const note of thread.notes) {
    if (note.kind === 'beyond') {
      for (const [from, to, y] of [
        [server, beyond, note.y - 6],
        [beyond, server, note.y + 6],
      ] as const) {
        const sign = to > from ? 1 : -1;

        parts.push(
          svgOf('path', {
            attributes: {
              class: 'arrow beyond',
              d: `M${String(from)} ${String(y)} H${String(to - sign * 6)}`,
            },
          }),
          svgOf('path', {
            attributes: {
              class: 'head',
              d: `M${String(to)} ${String(y)} l${String(-sign * 6)} -3.5 v7z`,
            },
          })
        );
      }

      parts.push(
        svgOf('text', {
          attributes: {
            class: 'note',
            'text-anchor': 'middle',
            x: (server + beyond) / 2,
            y: note.y - 12,
          },
          text: 'leg B, its own call ids',
        }),
        svgOf('text', {
          attributes: {
            class: 'note',
            'text-anchor': 'middle',
            x: (server + beyond) / 2,
            y: note.y + 20,
          },
          text: 'not seen from the page',
        })
      );
    } else {
      parts.push(
        svgOf('text', {
          attributes: {
            class: 'note',
            'data-room': roomOf(left),
            x: left,
            y: note.y + 8,
          },
          text:
            note.kind === 'pause'
              ? `… ${spanOf(note.value)} later`
              : `… ${numberOf(note.value)} envelopes not drawn`,
        })
      );
    }
  }

  for (const bead of thread.beads) {
    const [from, to] = bead.envelope.direction === 'tx' ? [page, server] : [server, page];
    const sign = to > from ? 1 : -1;
    const kind = bead.kind;
    const className =
      kind === 'FAILURE'
        ? 'failure'
        : kind === 'RESULT'
          ? 'answer'
          : kind === 'CREDIT'
            ? 'credit'
            : '';
    const radius = bead.isSmall ? 5 : 7;

    parts.push(
      svgOf('path', {
        attributes: {
          class: 'arrow',
          d: `M${String(from)} ${String(bead.y)} H${String(to - sign * 6)}`,
        },
      }),
      svgOf('path', {
        attributes: {
          class: 'head',
          d: `M${String(to)} ${String(bead.y)} l${String(-sign * 7)} -3.6 v7.2z`,
        },
      }),
      svgOf('circle', {
        attributes: { class: `bead ${className}`, cx: middle, cy: bead.y, r: radius },
        children: [
          svgOf('title', {
            text: `${bead.envelope.direction === 'tx' ? 'sent' : 'received'} ${kind}${bead.words === '' ? '' : `: ${bead.words}`}`,
          }),
        ],
      }),
      svgOf('text', {
        attributes: {
          class: 'kind',
          // * over the arrow, the kind keeps to the left of its bead
          'data-room': middle - radius - 4 - left,
          x: left,
          y: bead.y - 4,
        },
        text: kind === 'FAILURE' ? 'FAILURE ✕' : kind,
      }),
      svgOf('text', {
        attributes: { class: 'offset', 'text-anchor': 'end', x: page - MARGIN, y: bead.y + 4 },
        text: `+${numberOf(Math.round(bead.offset))}`,
      })
    );

    if (bead.words !== '') {
      parts.push(
        svgOf('text', {
          attributes: {
            class: 'words',
            'data-room': roomOf(left),
            x: left,
            y: bead.y + UNDER,
          },
          children: [svgOf('title', { text: bead.words })],
          text: bead.words,
        })
      );
    }
  }

  const svg = svgOf('svg', {
    attributes: {
      'aria-label': `The envelopes of ${call.callId === undefined ? 'the call' : `call #${String(call.callId)}`}, in order`,
      role: 'img',
      viewBox: `0 0 ${String(WIDTH)} ${String(thread.height)}`,
      width: WIDTH,
    },
    children: parts,
  });
  const views: Node[] = [make('div', { children: [svg], className: 'thread' })];
  const transfer = transferOf(call);
  const progress = progressOf(call);

  if (transfer !== undefined && progress !== undefined) {
    const credited = progress.credited;

    views.push(
      make('div', {
        attributes: {
          'aria-label': `Transfer: ${bytesOf(progress.passed)} of ${bytesOf(transfer.total)}`,
          role: 'img',
        },
        children: [
          make('i', {
            attributes: { style: `width:${String((progress.passed / transfer.total) * 100)}%` },
          }),
          ...(credited === undefined
            ? []
            : [
                make('u', {
                  attributes: {
                    style: `left:${String(Math.min(100, (credited / transfer.total) * 100))}%`,
                  },
                }),
              ]),
        ],
        className: 'progress',
      }),
      make('div', {
        children: [
          make('span', {
            text: `${progress.isWhole ? '' : 'at least '}${bytesOf(progress.passed)} of ${bytesOf(transfer.total)} ${transfer.direction === 'rx' ? 'received' : 'sent'}`,
          }),
          make('span', {
            text: credited === undefined ? 'no credit seen' : `credit up to ${bytesOf(credited)}`,
          }),
        ],
        className: 'legend',
      })
    );
  }

  if (call.envelopes.length === 0) {
    views.push(
      noteOf(
        call.callId === undefined
          ? 'No envelope went: the call was refused before its call id was drawn.'
          : 'No envelope of this call reached the panel.'
      )
    );
  }

  if (isRelayed) {
    views.push(
      noteOf(
        'The page sees leg A alone. A failure says how many relays it crossed; what leg B did is the server’s to trace.'
      )
    );
  }

  views.push(
    noteOf(
      'Each envelope is a bead on the call’s thread, in the order the page heard it, its time after the call’s first envelope on the left, in milliseconds.'
    )
  );

  return views;
};
