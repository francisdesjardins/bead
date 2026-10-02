// symbols

/**
 * Detaches and drops the socket as gracefully as it allows, without a `close` event. An open client
 * is left CLOSED at once; a connecting or closing one once its pending `connect` or `disconnect` has
 * settled, which the drop makes it do.
 */
export const dispose = Symbol('dispose');
