//! `payload-codecs`: the `json` and `text` codecs' readers, and the writers behind them: a value
//! that reads is written in its canonical form, which reads and writes as itself, and a text that
//! reads writes back as its bytes.

#![no_main]

use bead::{JsonCodec, PayloadCodec, TextCodec};
use bytes::Bytes;
use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    let payload = Bytes::copy_from_slice(data);

    if let Ok(value) = JsonCodec.decode(&payload)
        && let Ok(written) = JsonCodec.encode(&value)
    {
        let again = JsonCodec
            .decode(&written)
            .and_then(|value| JsonCodec.encode(&value));

        assert!(
            again.as_ref().is_ok_and(|again| *again == written),
            "a canonical form writes as itself"
        );
    }

    if let Ok(text) = TextCodec.decode(&payload) {
        assert!(
            TextCodec
                .encode(&text)
                .is_ok_and(|written| written == payload),
            "a text writes back as its bytes"
        );
    }
});
