/**
 * What a non-`Error` throw is called.
 *
 * `throw` takes any value, so a catch block holds `unknown`. `String(value)` is the obvious
 * coercion and the wrong one: it answers `[object Object]` for a plain object, and it *throws* —
 * inside an error path — for a null-prototype object or a failing `toString`.
 *
 * Only primitives carry a message worth keeping. Everything else is reported as what it is, because
 * a caller can tell `Non-error thrown` from a real message and cannot tell `[object Object]` from
 * one.
 *
 * A declaration rather than an arrow, the one exception to `func-style` that `.oxlintrc.json` makes
 * among the sources.
 *
 * @internal
 */
export function thrownMessage(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  if (value === null || value === undefined) {
    return String(value);
  }
  return 'Non-error thrown';
}
