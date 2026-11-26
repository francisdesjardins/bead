// ── A pinned download ─────────────────────────────────────────────────────────
// The bytes of a file the repository pins by its digest, downloaded with Node's own `fetch`: each
// Node tool that downloads a pinned file calls this. A pin is a sha256 in lower-case hexadecimal, or
// an integrity as Subresource Integrity writes it, `sha512-<base64>`, the form of npm's
// `dist.integrity`.
//
// A try that may pass later is made again: a network error, a body cut short, and the statuses 408,
// 429 and each 5xx (RFC 9110, 15.5.9 and 15.6; RFC 6585, 4). Each pause doubles the one before,
// from 2 s, unless the response's `Retry-After` gives one, in seconds or as an HTTP date (RFC 9110,
// 10.2.3); either is 60 s at most. Any other status that is no success is refused at once. The
// bytes are held to the pin before they are returned, and a mismatch is refused, never tried again.

import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

// ── The policy ────────────────────────────────────────────────────────────────

// how many tries a download makes at most, the first one included
const TRIES = 4;
// the pause before the second try, in milliseconds; each later one doubles it
const FIRST_PAUSE = 2_000;
// the longest pause between two tries, in milliseconds, a `Retry-After` included
const LONGEST_PAUSE = 60_000;
// a try's headers and body together: 10 MiB at about 175 KiB/s fit within a minute
const TRY_TIMEOUT = 60_000;
// Node's longest timer delay, in milliseconds, past which it fires at once
const LONGEST_TIMEOUT = 2 ** 31 - 1;

const SHA256 = /^[0-9a-f]{64}$/u;
const INTEGRITY = /^sha512-[A-Za-z0-9+/]+={0,2}$/u;

// ── The pin ───────────────────────────────────────────────────────────────────

// what `bytes` give in the pin's own form
const digestOf = (pin, bytes) => {
  if (SHA256.test(pin)) {
    return createHash('sha256').update(bytes).digest('hex');
  }

  return `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
};

// a digest as a refusal names it: a bare sha256 by its algorithm, an integrity as it is
const shownOf = (pin, digest) => {
  return SHA256.test(pin) ? `sha256 ${digest}` : digest;
};

// ── A try ─────────────────────────────────────────────────────────────────────

const isTransient = (status) => {
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
};

// `fetch`'s own error says little ("fetch failed"): its cause says why
const reasonOf = (error) => {
  const cause = error?.cause;
  // a cause's code, where its message does not already say it
  const code =
    cause?.code !== undefined && !String(cause.message).includes(cause.code) ? cause.code : '';
  const detail = [code, cause?.message].filter(Boolean).join(' ');

  return detail === '' ? String(error?.message ?? error) : `${error.message} (${detail})`;
};

// the pause a `Retry-After` asks for, in milliseconds; none when it is absent or unreadable
const retryAfterOf = (value) => {
  if (value === null) {
    return undefined;
  }

  const text = value.trim();

  if (/^\d+$/u.test(text)) {
    return Number(text) * 1_000;
  }

  const date = Date.parse(text);

  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
};

// one try: its bytes, or why it failed, whether a later try may pass, and the pause it asks for
const tryOnce = async (url, signal) => {
  let response;

  try {
    response = await fetch(url, { signal });
  } catch (error) {
    return { transient: true, reason: reasonOf(error) };
  }

  if (!response.ok) {
    // ! a body left unread holds its connection
    try {
      await response.body?.cancel();
    } catch {
      // a body that cannot be cancelled is already gone
    }

    return {
      transient: isTransient(response.status),
      reason: `${String(response.status)} ${response.statusText}`.trim(),
      wait: retryAfterOf(response.headers.get('retry-after')),
    };
  }

  try {
    return { bytes: Buffer.from(await response.arrayBuffer()) };
  } catch (error) {
    return { transient: true, reason: reasonOf(error) };
  }
};

// ── The download ──────────────────────────────────────────────────────────────

/**
 * The bytes `url` answers, once their digest is `pin`'s: a sha256 in lower-case hexadecimal, or an
 * integrity, `sha512-<base64>`. A network error, a body cut short, a 408, a 429 and a 5xx are tried
 * again, `options.tries` times in all, four by default, after a pause `options.pause(ms)` waits, a
 * timer by default. Any other failed status is refused at once, and so is a digest off the pin.
 * Each try's headers and body share `options.timeout` milliseconds, 60,000 by default; an expired
 * try is a network error. A test can give `options.timeoutSignal(ms)` in place of
 * `AbortSignal.timeout` to fire that bound without waiting.
 */
export const fetchPinned = async (url, pin, options = {}) => {
  const tries = options.tries ?? TRIES;
  const pause = options.pause ?? sleep;
  const timeout = options.timeout ?? TRY_TIMEOUT;
  const timeoutSignal = options.timeoutSignal ?? AbortSignal.timeout;

  if (typeof pin !== 'string' || (!SHA256.test(pin) && !INTEGRITY.test(pin))) {
    throw new Error(
      `${url}: its pin is no sha256 in lower-case hexadecimal and no integrity, sha512-<base64>`
    );
  }

  if (!Number.isInteger(tries) || tries < 1) {
    throw new Error(`${url}: ${String(tries)} tries, where a download makes one at least`);
  }

  if (!Number.isInteger(timeout) || timeout < 1 || timeout > LONGEST_TIMEOUT) {
    throw new Error(
      `${url}: a try's timeout is 1 to ${String(LONGEST_TIMEOUT)} milliseconds, not ${String(timeout)}`
    );
  }

  let last;

  for (let attempt = 1; attempt <= tries; attempt += 1) {
    const answer = await tryOnce(url, timeoutSignal(timeout));

    if (answer.bytes !== undefined) {
      const digest = digestOf(pin, answer.bytes);

      // ! no caller reads a byte before its digest is the pin's
      if (digest !== pin) {
        throw new Error(`${url}: ${shownOf(pin, digest)}, where the pin says ${shownOf(pin, pin)}`);
      }

      return answer.bytes;
    }

    if (!answer.transient) {
      throw new Error(`${url}: ${answer.reason}`);
    }

    last = answer.reason;

    if (attempt < tries) {
      const backoff = FIRST_PAUSE * 2 ** (attempt - 1);

      await pause(Math.min(answer.wait ?? backoff, LONGEST_PAUSE));
    }
  }

  throw new Error(`${url}: ${last}, after ${String(tries)} ${tries === 1 ? 'try' : 'tries'}`);
};
