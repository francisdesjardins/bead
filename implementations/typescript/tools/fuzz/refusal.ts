// ── A target's refusals ───────────────────────────────────────────────────────

// What every fuzz target shares: a parser fed raw bytes returns, or refuses with the error it is
// designed to give, and anything else it throws is a finding, which goes on to the fuzzer.

// types

/** The class of the error a parser refuses with, by its documentation. */
export type Refusal = abstract new (given: never) => Error;

// definition

/**
 * Whether `read` refused with an error of `refusal`'s, which passes; it returns otherwise, and any
 * other error it throws goes on, a finding.
 */
export const isRefused = (refusal: Refusal, read: () => void): boolean => {
  try {
    read();
  } catch (reason) {
    if (reason instanceof refusal) {
      return true;
    }

    throw reason;
  }

  return false;
};

/** `bytes` in hexadecimal, two lower-case digits a byte, for a finding's message. */
export const hexadecimalOf = (bytes: Uint8Array): string => {
  return Array.from(bytes, (byte) => {
    return byte.toString(16).padStart(2, '0');
  }).join('');
};
