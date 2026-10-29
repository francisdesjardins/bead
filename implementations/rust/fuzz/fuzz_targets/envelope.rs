//! `envelope`: the envelope reader, its header then its body, at either side, and a failure's
//! record; what reads is written back, and reads again as it was.

#![no_main]

use bead::{ReadEnvelopeOptions, RouterSide, read_envelope, read_failure, write_envelope};
use bytes::Bytes;
use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    let bytes = Bytes::copy_from_slice(data);

    for side in [RouterSide::Server, RouterSide::Client] {
        if let Ok(Some(envelope)) = read_envelope(&bytes, side, &ReadEnvelopeOptions::default())
            && let Ok(written) = write_envelope(&envelope, 1_024)
        {
            let again = read_envelope(&written, side, &ReadEnvelopeOptions::default());

            assert!(
                matches!(&again, Ok(Some(read)) if *read == envelope),
                "what reads is written back as it was: {envelope:?}"
            );
        }

        drop(read_failure(data, (side, 1_024)));
    }
});
