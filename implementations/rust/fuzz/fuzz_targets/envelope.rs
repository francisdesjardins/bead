//! `envelope`: the envelope reader, its header then its body, at either side, and a failure's
//! record; what reads is written back, and from that writing on is written again as it was. The
//! TypeScript side's `tools/fuzz/envelope.ts` and the C# side's `EnvelopeTarget` are its twins.

#![no_main]

use bead::RouterSide;
use bead::internal::{ReadEnvelopeOptions, read_envelope, read_failure, write_envelope};
use bytes::Bytes;
use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    let bytes = Bytes::copy_from_slice(data);

    for side in [RouterSide::Server, RouterSide::Client] {
        // ! the first writing is the fixed point, not the input: a detail's bytes that are no UTF-8
        // read as U+FFFD (spec 7.3), three bytes each, and its writing cuts them again (7.4)
        if let Ok(Some(envelope)) = read_envelope(&bytes, side, &ReadEnvelopeOptions::default())
            && let Ok(written) = write_envelope(&envelope, 1_024)
        {
            let read = read_envelope(&written, side, &ReadEnvelopeOptions::default());

            assert!(
                matches!(&read, Ok(Some(_))),
                "what is written reads: {envelope:?}"
            );

            if let Ok(Some(normal)) = read {
                assert!(
                    matches!(write_envelope(&normal, 1_024), Ok(rewritten) if rewritten == written),
                    "what is written back is written as it was: {normal:?}"
                );
            }
        }

        let mut options = ReadEnvelopeOptions::default();

        options.maximum_detail_bytes = Some(1_024);
        drop(read_failure(data, side, &options));
    }
});
