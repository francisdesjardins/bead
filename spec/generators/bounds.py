"""The bounds' defaults sections 15.3 and 15.12 state, by the names they give them, in milliseconds for a
time: spec/transports.json's defaults, and the defaults of spec/durations.json's places that 15.12
states, both read from here, so the two files cannot disagree."""

# a router's limits by default that the bounds are drawn from (spec 12.2): its largest envelope, its
# chunk, its window, the transfers a connection receives at once, and the calls a connection's peer
# has it answer at once
MAXIMUM_ENVELOPE_BYTES = 16_778_240
CHUNK_BYTES = 1_048_576
WINDOW_BYTES = 4_194_304
MAXIMUM_TRANSFERS = 4
MAXIMUM_ANSWERING_CALLS = 64

# what a peer that keeps every rule can be owed at once on a WebSocket: the answers to the calls it
# has answered, the server's own commands to it, as many, the transfers it receives, and two envelopes
# of the server's own besides, as an HTTP outbox holds (spec 15.12)
MAXIMUM_UNSENT_BYTES = (2 * MAXIMUM_ANSWERING_CALLS * CHUNK_BYTES + MAXIMUM_TRANSFERS * WINDOW_BYTES
                        + 2 * MAXIMUM_ENVELOPE_BYTES)
assert MAXIMUM_UNSENT_BYTES == 184_551_424

DEFAULTS = {
    'maximumConnections': 10_000,
    'maximumConnectionsPerAddress': 64,
    'maximumWaitingExchanges': MAXIMUM_ANSWERING_CALLS,
    'bodyBytesBudget': 268_435_456,
    'maximumBodyBytes': MAXIMUM_ENVELOPE_BYTES,
    'maximumOutboxBytes': 2 * MAXIMUM_ENVELOPE_BYTES,
    'maximumWait': 30_000,
    'exchangeTimeout': 300_000,
    'inactivityTimeout': 300_000,
    'connectionInactivityTimeout': 30_000,
    'minimumSendBytesPerSecond': 240,
    'sendGracePeriod': 5_000,
    'maximumUnsentBytes': MAXIMUM_UNSENT_BYTES,
    'headersTimeout': 30_000,
    'minimumBodyBytesPerSecond': 240,
    'bodyGracePeriod': 5_000,
    'maximumMessageBytes': MAXIMUM_ENVELOPE_BYTES,
    'heartbeat': 30_000,
}
