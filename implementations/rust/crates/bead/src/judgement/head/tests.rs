//! A request's head read under its bounds: 16 KiB, its request line among it, and 100 fields, 431
//! past either, 400 for one HTTP does not read, each octet past ASCII the character of its
//! Latin-1 code.

use super::{Head, HeadRead, MAXIMUM_HEAD_BYTES, MAXIMUM_HEAD_FIELDS, read_head};

// a head of `fields` lines, each `name: value`, then what follows it
fn head_of(request_line: &str, fields: &[String]) -> Vec<u8> {
    let mut head = format!("{request_line}\r\n");

    for field in fields {
        head.push_str(field);
        head.push_str("\r\n");
    }

    head.push_str("\r\n");
    head.into_bytes()
}

// `length` letters a, a value or a path that long
fn a_run(length: usize) -> String {
    core::iter::repeat_n('a', length).collect()
}

fn fields(count: usize) -> Vec<String> {
    (0..count)
        .map(|index| format!("x-{index}: {index}"))
        .collect()
}

#[test]
fn reads_a_head_whole_its_method_target_version_and_fields_as_they_came_each_octet_past_ascii_its_latin_1_character()
 {
    let mut bytes = b"GET /bead?x=1 HTTP/1.1\r\nHost: bead.test\r\nX-Other:  caf".to_vec();

    bytes.extend_from_slice(&[0xE9, b'\t', b'\r', b'\n', b'\r', b'\n']);

    let length = bytes.len();

    // what follows the head is the request's, never the head's
    bytes.extend_from_slice(b"\x81\x80");

    assert_eq!(
        read_head(&bytes),
        HeadRead::Whole(Head {
            method: "GET".to_owned(),
            target: "/bead?x=1".to_owned(),
            http_version: "1.1",
            raw_fields: ["Host", "bead.test", "X-Other", "caf\u{e9}"]
                .map(str::to_owned)
                .to_vec(),
            length,
        }),
        "its parts, its value trimmed"
    );
    assert!(
        matches!(read_head(b"GET / HTTP/1.0\r\n\r\n"), HeadRead::Whole(head) if head.http_version == "1.0" && head.fields().is_empty()),
        "an HTTP/1.0 head"
    );
}

#[test]
fn waits_for_a_head_not_whole_within_its_bounds() {
    for partial in [
        &b""[..],
        b"GET",
        b"GET / HTTP/1.1\r\n",
        b"GET / HTTP/1.1\r\nHost: bead.test\r\n",
        b"GET / HTTP/1.1\r\nHost: bead.test\r\n\r",
    ] {
        assert_eq!(read_head(partial), HeadRead::Partial, "{partial:?}");
    }
}

#[test]
fn refuses_431_a_head_past_16_kib_its_request_line_among_it_or_past_100_fields() {
    let line = "GET / HTTP/1.1";
    let padding = |length: usize| vec![format!("x-pad: {}", a_run(length))];
    // a head of exactly the bound: its request line, its field, its empty line
    let bound = padding(MAXIMUM_HEAD_BYTES - line.len() - 2 - "x-pad: ".len() - 2 - 2);
    let past = padding(MAXIMUM_HEAD_BYTES - line.len() - 2 - "x-pad: ".len() - 2 - 1);

    assert!(
        matches!(read_head(&head_of(line, &bound)), HeadRead::Whole(head) if head.length == MAXIMUM_HEAD_BYTES),
        "a head of 16 KiB taken"
    );
    assert_eq!(
        read_head(&head_of(line, &past)),
        HeadRead::Refused(431),
        "a byte past it"
    );

    // a head still coming at its bound can only end past it
    let coming = head_of(line, &past);

    assert_eq!(
        read_head(coming.get(..MAXIMUM_HEAD_BYTES).unwrap_or_default()),
        HeadRead::Refused(431),
        "still coming at its bound"
    );
    assert!(
        matches!(read_head(&head_of(line, &fields(MAXIMUM_HEAD_FIELDS))), HeadRead::Whole(head) if head.raw_fields.len() == 2 * MAXIMUM_HEAD_FIELDS),
        "100 fields taken"
    );
    assert_eq!(
        read_head(&head_of(line, &fields(MAXIMUM_HEAD_FIELDS + 1))),
        HeadRead::Refused(431),
        "past 100 fields"
    );
    // its request line among its bytes
    let target = format!("/{}", a_run(MAXIMUM_HEAD_BYTES));

    assert_eq!(
        read_head(&head_of(&format!("GET {target} HTTP/1.1"), &[])),
        HeadRead::Refused(431),
        "a request line past it"
    );
}

#[test]
fn refuses_400_a_head_http_does_not_read_a_control_character_in_its_target_or_a_value_among_it() {
    for malformed in [
        &b"GET /a\x01b HTTP/1.1\r\n\r\n"[..],
        b"GET /a\x7fb HTTP/1.1\r\n\r\n",
        b"GET /a b HTTP/1.1\r\n\r\n",
        b"GET / HTTP/2.0\r\n\r\n",
        b"GET / HTTP/1.1\r\nx-other: a\x07b\r\n\r\n",
        b"GET / HTTP/1.1\r\nno colon\r\n\r\n",
        b"GET / HTTP/1.1\r\nbad name: x\r\n\r\n",
        b"G(T / HTTP/1.1\r\n\r\n",
    ] {
        assert_eq!(
            read_head(malformed),
            HeadRead::Refused(400),
            "{malformed:?}"
        );
    }
}
