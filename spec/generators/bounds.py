"""The bounds' defaults sections 15.3 and 15.12 state, by the names they give them, in milliseconds for a
time: spec/transports.json's defaults, and the defaults of spec/durations.json's places that 15.12
states, both read from here, so the two files cannot disagree."""

# a router's largest envelope, maximumEnvelopeBytes's default (spec 12.2)
MAXIMUM_ENVELOPE_BYTES = 16_778_240

DEFAULTS = {
    'maximumConnections': 10_000,
    'maximumConnectionsPerAddress': 64,
    'maximumWaitingExchanges': 64,
    'bodyBytesBudget': 268_435_456,
    'maximumBodyBytes': MAXIMUM_ENVELOPE_BYTES,
    'maximumOutboxBytes': 2 * MAXIMUM_ENVELOPE_BYTES,
    'maximumWait': 30_000,
    'exchangeTimeout': 300_000,
    'inactivityTimeout': 300_000,
    'connectionInactivityTimeout': 30_000,
    'maximumMessageBytes': MAXIMUM_ENVELOPE_BYTES,
    'heartbeat': 30_000,
}
