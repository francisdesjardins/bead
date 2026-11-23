//! `websocket-frames`: raw bytes, as a client sends them over a WebSocket, fed to the frame meter
//! of the WebSocket transport (spec 15.3, decision 0056) and to tungstenite, which reads the same
//! bytes from a cursor: they agree on the bounds of each frame, on the end of each message, and on
//! whether the stream fails, and at which frame; the meter hands the same bytes whether its input
//! comes whole or cut where the input's first byte says, and never panics. The test kit's
//! `websocket_frames` holds the properties, which the side's mutation test holds too.

#![no_main]

use bead::testing::websocket_frames::broken;
use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    if let Some(broken) = broken(data) {
        panic!("{broken}");
    }
});
