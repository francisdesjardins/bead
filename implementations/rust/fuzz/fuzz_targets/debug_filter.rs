//! `debug-filter`: the `debug` filter's parser, and the patterns of a filter it returns, asked of a
//! call and of an envelope of each kind.

#![no_main]

use bead::{
    CallAsked, DebugDirection, DebugFilterSource, DebugType, EnvelopeAsked, EnvelopeKind,
    FilterKeeper, GivenFilter, parse_debug_filter,
};
use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    let Ok(spec) = core::str::from_utf8(data) else {
        return;
    };
    let Ok(filter) = parse_debug_filter(spec) else {
        return;
    };
    let Ok(keeper) = FilterKeeper::new(DebugFilterSource::Given(GivenFilter::Filter(filter)))
    else {
        return;
    };

    for direction in [DebugDirection::Rx, DebugDirection::Tx] {
        for call_type in [
            DebugType::Request,
            DebugType::Command,
            DebugType::Notification,
        ] {
            for procedure_name in ["echo", "endSessionsOf", "", spec] {
                core::hint::black_box(keeper.keeps_call(&CallAsked {
                    direction,
                    call_type,
                    procedure_name,
                }));
            }
        }

        for kind in EnvelopeKind::ALL {
            core::hint::black_box(keeper.keeps_envelope(EnvelopeAsked { direction, kind }));
        }
    }
});
