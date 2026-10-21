// ── Demo sign-up ──────────────────────────────────────────────────────────────

// The sign-up form, over the service beadc generated from proto/demo/v1/sign_up.proto: its request
// held to the rules of its .proto, by the server before its resolver, or by the client before it
// goes when the form asks it to. A refusal, PAYLOAD_INVALID, is read by the runtime's reader, and
// each violation it carries is bound to the field its path names; one of no field is shown above
// the form.

// dependencies

import type { IClient } from '../src/client/types';
import { CredentialScheme, FailureError } from '../src/client/ws-client';
import { type IReadViolations, type IViolation, violationsOf } from '../src/service/service';
import { SignUpClient } from './gen/typescript/demo/v1/sign_up_bead';

// interfaces

/** A field of the form: its input, its hint, and where its violations are written. */
interface IField {
  hint: HTMLElement;
  input: HTMLInputElement;
  messages: HTMLElement;
}

/** What the form is given besides its client: how the page says why a call failed. */
interface ISignUpOptions {
  reasonOf: (reason: unknown) => string;
}

// types

/** The form's fields, in the order of their numbers in the .proto, which a refusal keeps. */
type FieldName = (typeof FIELDS)[number];

/** What the form holds, as its inputs hold it: text. */
type Filled = Readonly<Record<FieldName, string>>;

// constants

const FIELDS = Object.freeze(['name', 'seats', 'email', 'phone'] as const);

/** A sign-up its rules take: a name, two seats, and an email alone. */
const VALID: Filled = Object.freeze({
  email: 'ada@example.org',
  name: 'ada',
  phone: '',
  seats: '2',
});

/**
 * A sign-up every field of which breaks a rule: a name off its pattern, seats past 10, an email with
 * no dot in its domain, a phone with no +, and both an email and a phone, which the message's own
 * rule refuses, of no field.
 */
const BROKEN: Filled = Object.freeze({
  email: 'ada@example',
  name: '9 Lives!',
  phone: '555-0100',
  seats: '12',
});

// what an int32 holds
const INT32_LOWEST = -(2 ** 31);
const INT32_HIGHEST = 2 ** 31 - 1;

const WHOLE = /^[+-]?\d+$/u;

/** A call the form makes presents no credential: the procedure admits every call. */
const PUBLIC = Object.freeze({ credential: { scheme: CredentialScheme.NONE }, timeout: 5_000 });

// helpers

const elementOf = (id: string): HTMLElement => {
  const element = document.getElementById(id);

  if (element === null) {
    throw new Error(`the page has no #${id}`);
  }

  return element;
};

const isField = (name: string): name is FieldName => {
  return (FIELDS as readonly string[]).includes(name);
};

/**
 * The seats, as an int32 holds them: a whole number, held within the type, where the rules judge
 * it; anything else 0, which they refuse too.
 */
const seatsOf = (text: string): number => {
  const trimmed = text.trim();

  return WHOLE.test(trimmed) ? Math.min(Math.max(Number(trimmed), INT32_LOWEST), INT32_HIGHEST) : 0;
};

/** The field a violation's path names: its first element (spec 18.4), none for the message's own. */
const fieldOf = ({ fieldPath }: IViolation): FieldName | undefined => {
  const [first = ''] = (fieldPath ?? '').split(/[.[]/u);

  return isField(first) ? first : undefined;
};

/** A violation's words, as the reader gave them, else its rule's id. */
const wordsOf = (violation: IViolation): string => {
  return violation.message ?? violation.ruleId;
};

const plural = (count: number, word: string): string => {
  return `${String(count)} ${word}${count === 1 ? '' : 's'}`;
};

/** What the closing line said of the violations the detail left out: none, `and N more`, or a stop. */
const closingOf = ({ more, stopped }: IReadViolations): string => {
  if (stopped === true) {
    return ', stopped at the first';
  }

  return more === undefined || more === 0 ? '' : `, and ${String(more)} more`;
};

// definition

/**
 * The sign-up form, on `client`: filled with a sign-up its rules take, sent by its own requester,
 * which judges it first when "Validate before sending" is checked.
 */
export const mountSignUp = (client: IClient, { reasonOf }: ISignUpOptions): void => {
  // a form and a checkbox, as the page declares them
  const form = elementOf('sign-up') as HTMLFormElement;
  const validates = elementOf('sign-up-validates') as HTMLInputElement;
  // * an alert holding a list, so the list keeps its semantics
  const unbound = elementOf('sign-up-unbound');
  const unboundList = elementOf('sign-up-unbound-list');
  const status = elementOf('sign-up-status');
  const fields = Object.fromEntries(
    FIELDS.map((name) => {
      return [
        name,
        {
          hint: elementOf(`sign-up-${name}-hint`),
          input: elementOf(`sign-up-${name}`) as HTMLInputElement,
          messages: elementOf(`sign-up-${name}-messages`),
        },
      ];
    })
  ) as Record<FieldName, IField>;
  // * one client side a way of sending: `validates` is each's, as it is built
  const sent = new SignUpClient(client);
  const judged = new SignUpClient(client, { validates: true });

  // a field as it was before any refusal: described by its hint alone
  const clearField = ({ hint, input, messages }: IField): void => {
    input.removeAttribute('aria-invalid');
    input.setAttribute('aria-describedby', hint.id);
    messages.replaceChildren();
    messages.hidden = true;
  };

  const clearAll = (): void => {
    for (const field of Object.values(fields)) {
      clearField(field);
    }

    unboundList.replaceChildren();
    unbound.hidden = true;
  };

  const fill = (filled: Filled): void => {
    clearAll();

    for (const name of FIELDS) {
      fields[name].input.value = filled[name];
    }

    status.textContent = '—';
  };

  const itemOf = (text: string): HTMLLIElement => {
    const item = document.createElement('li');

    item.textContent = text;

    return item;
  };

  // * each violation under the input its path names, the input marked and described by them; one of
  // no field above the form; then the first field refused takes the focus, in the order of the form
  const showRefusal = (read: IReadViolations): void => {
    const bound = new Map<FieldName, IViolation[]>();
    const left: IViolation[] = [];

    for (const violation of read.violations) {
      const name = fieldOf(violation);

      if (name === undefined) {
        left.push(violation);
      } else {
        bound.set(name, [...(bound.get(name) ?? []), violation]);
      }
    }

    for (const [name, violations] of bound) {
      const { hint, input, messages } = fields[name];

      messages.replaceChildren(
        ...violations.map((violation) => {
          return itemOf(wordsOf(violation));
        })
      );
      messages.hidden = false;
      input.setAttribute('aria-invalid', 'true');
      input.setAttribute('aria-describedby', `${messages.id} ${hint.id}`);
    }

    unboundList.replaceChildren(
      ...left.map((violation) => {
        const words = wordsOf(violation);

        // a path the form holds no field of is said with it
        return itemOf(
          violation.fieldPath === undefined ? words : `${violation.fieldPath}: ${words}`
        );
      })
    );
    unbound.hidden = left.length === 0;

    const first = FIELDS.find((name) => {
      return bound.has(name);
    });

    (first === undefined ? unbound : fields[first].input).focus();
  };

  const send = async (): Promise<void> => {
    const isJudged = validates.checked;
    const requester = isJudged ? judged : sent;

    clearAll();
    status.textContent = isJudged ? 'judging, then sending…' : 'sending…';

    try {
      const { welcome } = await requester.signUp({
        email: fields.email.input.value,
        name: fields.name.input.value,
        phone: fields.phone.input.value,
        seats: seatsOf(fields.seats.input.value),
      })(PUBLIC);

      status.textContent = `signed up: ${welcome}`;
    } catch (reason) {
      const read =
        reason instanceof FailureError ? violationsOf(reason) : { violations: [] as IViolation[] };

      if (read.violations.length === 0) {
        status.textContent = `refused: ${reasonOf(reason)}`;

        return;
      }

      // * a refusal raised here never left: the client judged it, and nothing went on the wire
      const where =
        reason instanceof FailureError && reason.origin === 'local'
          ? 'refused by the client before it went, nothing on the wire'
          : 'refused by the server before its resolver';

      status.textContent = `${where}: PAYLOAD_INVALID, ${plural(read.violations.length, 'violation')}${closingOf(read)}`;
      showRefusal(read);
    }
  };

  // a field changed is judged anew when sent: its messages go
  for (const field of Object.values(fields)) {
    field.input.addEventListener('input', () => {
      clearField(field);
    });
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void send();
  });
  elementOf('sign-up-valid').addEventListener('click', () => {
    fill(VALID);
  });
  elementOf('sign-up-broken').addEventListener('click', () => {
    fill(BROKEN);
  });
  fill(VALID);
};
