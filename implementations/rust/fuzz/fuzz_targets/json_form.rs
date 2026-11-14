//! `json-form`: protobuf's JSON read by Bead's own mapping, `JsonForm` (transcoding 5), over
//! `spec/transcoding.proto`'s `Everything` and `Edges`. The input's first byte picks the message,
//! `Everything` when it is even and `Edges` when it is odd; the rest is read as a body (5.2). What
//! reads is written; what was written reads; and it writes again to the same text, byte for byte. A
//! refusal of the reading, `MessageFormError::Form`, is the form's documented one; any other
//! refusal, a write's refusal of what read, or a second text that differs is a finding. No
//! message's bytes are compared: a map's entries read in the text's order are written in 17.7.6's,
//! and a `-0` is written `0` or left out (5.6). The TypeScript side's `tools/fuzz/json-form.ts` and
//! the C# side's `JsonFormTarget` are its twins.

#![no_main]

use std::fmt::Write as _;
use std::sync::{Arc, LazyLock};

use bead::{MessageForm, MessageFormError};
use bead_protobuf::{JsonForm, ProtoSchema};
use buffa_descriptor::DescriptorPool;
use libfuzzer_sys::fuzz_target;

// the messages the first byte picks, by its parity
const MESSAGES: [&str; 2] = [
    "bead.transcoding.v1.Everything",
    "bead.transcoding.v1.Edges",
];

// each its form over the set protoc wrote of `spec/transcoding.proto` and its imports, which the
// JSON form's own tests read by their descriptors alone
static FORMS: LazyLock<[Arc<dyn MessageForm>; 2]> = LazyLock::new(|| {
    let pool = Arc::new(
        DescriptorPool::decode(include_bytes!(
            "../../crates/bead-protobuf/proto/tests.binpb"
        ))
        .expect("the tests' descriptor set reads"),
    );
    let form = JsonForm::new(Arc::clone(&pool));

    MESSAGES.map(|name| {
        let index = pool
            .message_index(name)
            .unwrap_or_else(|| panic!("the set holds {name}"));

        form.form_of(ProtoSchema::new(Arc::clone(&pool), index))
    })
});

// the input, in hexadecimal, as a finding names it
fn hexadecimal_of(data: &[u8]) -> String {
    data.iter().fold(String::new(), |mut text, byte| {
        let _ = write!(text, "{byte:02x}");

        text
    })
}

fuzz_target!(|data: &[u8]| {
    let Some((pick, body)) = data.split_first() else {
        return;
    };
    let form = &FORMS[usize::from(pick % 2)];
    let payload = match form.read(body) {
        Ok(payload) => payload,
        // * a refusal is the answer to a body that is no such message: any other is a finding
        Err(MessageFormError::Form(_)) => return,
        Err(error) => panic!("a body is refused otherwise than by the form: {error}"),
    };

    // * from here every refusal is a finding: the form writes what it read, and reads what it wrote
    let written = form
        .write(&payload, None)
        .unwrap_or_else(|error| panic!("what read is not written: {error}"));
    let again = form
        .read(written.as_bytes())
        .and_then(|payload| form.write(&payload, None))
        .unwrap_or_else(|error| panic!("what was written does not read and write: {error}"));

    assert!(
        again == written,
        "a JSON text is written again otherwise: {}",
        hexadecimal_of(data)
    );
});
