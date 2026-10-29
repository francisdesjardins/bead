//! The parcel's codec (spec 15.17) against `spec/vectors.json`'s `parcels` and `parcelRefusals`,
//! which the other sides' codecs play alike: each parcel read to its fields and written back to its
//! bytes, but those no writer writes, and each refusal told apart as no parcel or a parcel that does
//! not read.

#![expect(
    clippy::too_many_lines,
    reason = "a twin plays its sentence whole, as the other sides' twins do"
)]

use bytes::Bytes;

use crate::broker::parcel::{
    LARGEST_BOUND, LARGEST_SEQUENCE, Parcel, ParcelRead, encode_parcel, flags, is_token,
    kind_named, kinds, read_parcel, write_parcel,
};
use crate::testing::parcels::{self, ParcelReading, ParcelRefusalVector, ParcelVector};
use crate::testing::vectors;

const OPENER: u64 = 0x1112_1314_1516_1718;
const ACCEPTOR: u64 = 0x2122_2324_2526_2728;

fn read_of(parcel: &Parcel) -> ParcelRead {
    read_parcel(&Bytes::from(encode_parcel(parcel).expect("encoded")))
}

#[test]
fn writes_and_reads_each_kind_of_parcel_byte_for_byte_reads_a_layout_to_come_by_its_prefix_and_refuses_a_parcel_that_does_not_read()
 {
    let entries: Vec<ParcelVector> = vectors::of("parcels").expect("the parcels");
    let refusals: Vec<ParcelRefusalVector> =
        vectors::of("parcelRefusals").expect("the parcel refusals");

    for vector in &entries {
        let bytes = vectors::bytes_of(&vector.bytes).expect("bytes");
        let expected = parcels::normalized(&vector.parcel).expect("its fields");

        assert_eq!(
            parcels::read(&bytes),
            ParcelReading::Parcel(expected.clone()),
            "{}",
            vector.name
        );

        if vector.written == Some(false) {
            assert!(
                parcels::write(&expected).is_err(),
                "{}: a parcel no writer writes",
                vector.name
            );
        } else {
            assert_eq!(
                parcels::write(&expected).expect("written"),
                bytes.to_vec(),
                "{}",
                vector.name
            );
        }
    }

    for vector in &refusals {
        let bytes = vectors::bytes_of(&vector.bytes).expect("bytes");
        let refused = match parcels::read(&bytes) {
            ParcelReading::NoParcel(_) => "no-parcel",
            // * a parcel that does not read keeps its prefix, which names the connection it closes
            ParcelReading::DoesNotRead(prefix, _) => {
                assert_eq!(
                    prefix.opener.len(),
                    23,
                    "{}: its prefix's half",
                    vector.name
                );

                "does-not-read"
            }
            ParcelReading::Parcel(_) => "a parcel",
        };

        assert_eq!(refused, vector.refused, "{}", vector.name);
    }

    // each kind the file holds, and each refusal of either sort
    let mut kinds_held: Vec<u8> = entries.iter().map(|vector| vector.parcel.kind).collect();

    kinds_held.sort_unstable();
    kinds_held.dedup();
    assert_eq!(
        kinds_held,
        [1, 2, 3, 4, 5, 6, 7, 8, 9, 0x80, 0xFF],
        "each kind, and the advisory's first and last"
    );
}

#[test]
fn writes_no_parcel_a_side_refuses_nor_one_of_a_kind_no_writer_writes() {
    let open = Parcel {
        opener: OPENER,
        sequence: 1,
        id: Some("peer".to_owned()),
        incarnation: Some(1),
        bound: Some(1_024),
        ..Parcel::of(kinds::OPEN)
    };
    let ping = Parcel {
        opener: OPENER,
        acceptor: ACCEPTOR,
        sequence: 2,
        ..Parcel::of(kinds::PING)
    };
    let unfielded = Parcel {
        kind: kinds::DATA,
        flags: Some(flags::CREDENTIAL),
        credential: Some(" Bearer x".to_owned()),
        carried: Some(Bytes::from_static(&[1])),
        ..ping.clone()
    };
    let refused = [
        (
            "a DATA whose credential is no field value",
            unfielded.clone(),
        ),
        (
            "an advisory kind",
            Parcel {
                kind: 0x80,
                ..ping.clone()
            },
        ),
        (
            "a kind to come",
            Parcel {
                kind: 0x0A,
                ..ping.clone()
            },
        ),
        (
            "a kind of 0x00",
            Parcel {
                kind: 0,
                ..ping.clone()
            },
        ),
        (
            "a layout to come",
            Parcel {
                layout: 0xB2,
                ..ping.clone()
            },
        ),
        (
            "an OPEN whose id is no token",
            Parcel {
                id: Some("a/b".to_owned()),
                ..open.clone()
            },
        ),
        (
            "an OPEN whose receive bound is under 1,024",
            Parcel {
                bound: Some(1_023),
                ..open.clone()
            },
        ),
        (
            "an OPEN whose receive bound passes its 4 bytes",
            Parcel {
                bound: Some(LARGEST_BOUND + 1),
                ..open.clone()
            },
        ),
        (
            "an OPEN naming an acceptor's half",
            Parcel {
                acceptor: ACCEPTOR,
                ..open.clone()
            },
        ),
        (
            "an ACCEPT whose receive bound is under 1,024",
            Parcel {
                kind: kinds::ACCEPT,
                acceptor: ACCEPTOR,
                bound: Some(1_023),
                ..open.clone()
            },
        ),
        (
            "a PING marked SECURE",
            Parcel {
                flags: Some(flags::SECURE),
                ..ping.clone()
            },
        ),
        (
            "a PING whose acceptor's half is zero",
            Parcel {
                acceptor: 0,
                ..ping.clone()
            },
        ),
        (
            "a PING of sequence 0",
            Parcel {
                sequence: 0,
                ..ping.clone()
            },
        ),
        (
            "a PING past 2⁵³ − 1",
            Parcel {
                sequence: LARGEST_SEQUENCE + 1,
                ..ping.clone()
            },
        ),
        (
            "a RESET with a sequence",
            Parcel {
                kind: kinds::RESET,
                ..ping.clone()
            },
        ),
        (
            "a DATA carrying nothing",
            Parcel {
                kind: kinds::DATA,
                ..ping.clone()
            },
        ),
        (
            "a CLOSE of 1003",
            Parcel {
                kind: kinds::CLOSE,
                code: Some(1_003),
                ..ping.clone()
            },
        ),
    ];

    for (what, parcel) in &refused {
        assert!(write_parcel(parcel).is_err(), "{what} is never written");
    }

    // a credential that is no field value does not read (spec 15.5)
    assert!(
        matches!(read_of(&unfielded), ParcelRead::DoesNotRead(_, why) if why == "a credential that is no field value"),
        "a credential that is no field value does not read"
    );

    // what a side sends reads back as it was written
    for parcel in [&open, &ping] {
        let written = write_parcel(parcel).expect("written");

        assert!(
            matches!(read_parcel(&written), ParcelRead::Parcel(_)),
            "what a side sends reads back"
        );
    }
}

#[test]
fn takes_a_token_of_1_to_64_characters_of_base64url_s_alphabet_and_nothing_else() {
    let longest = "x".repeat(64);
    let past = "x".repeat(65);

    for token in [
        "a",
        "Z",
        "0",
        "-",
        "_",
        "peer",
        &longest,
        "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_",
    ] {
        assert!(is_token(token), "{token} is a token");
    }

    for text in [
        "", &past, "a/b", "a.b", "a b", "a+b", "a#b", "$share", "a*", "a>", "é", "a=",
    ] {
        assert!(!is_token(text), "{text} is no token");
    }
}

#[test]
fn writes_no_character_past_u_00ff_in_an_id_or_a_credential_nor_an_id_that_is_no_token_where_a_token_is_due()
 {
    const HALF: u64 = 0x1112_1314_1516_1718;
    let gone = Parcel {
        incarnation: Some(0),
        ..Parcel::of(kinds::GONE)
    };
    let refused = [
        (
            Parcel {
                id: Some("a€".to_owned()),
                ..gone.clone()
            },
            "an id is written a character a byte, not \"a€\"",
        ),
        (
            Parcel {
                flags: Some(flags::CREDENTIAL),
                opener: HALF,
                acceptor: HALF,
                sequence: 3,
                credential: Some("Bearer €".to_owned()),
                carried: Some(Bytes::from_static(&[1])),
                ..Parcel::of(kinds::DATA)
            },
            "a credential is written a character a byte, not \"Bearer €\"",
        ),
        (
            Parcel {
                id: Some("a.b".to_owned()),
                ..gone
            },
            "a parcel this side refuses is never written: an id that is no token",
        ),
        (
            Parcel {
                opener: HALF,
                sequence: 1,
                id: Some("é".to_owned()),
                incarnation: Some(0),
                bound: Some(1_024),
                ..Parcel::of(kinds::OPEN)
            },
            "an OPEN names a token and a receive bound of 1,024 bytes at least",
        ),
    ];

    for (parcel, refusal) in &refused {
        // * refused, never written as a stand-in
        let error = write_parcel(parcel).expect_err("refused");

        assert!(
            error.message().starts_with(refusal),
            "{} is {refusal}",
            error.message()
        );
    }
}

#[test]
fn names_a_kind_as_a_report_does_its_article_before_it_and_reads_an_advisory_parcel_to_its_prefix_but_one_with_no_sequence()
 {
    const HALF: u64 = 0x1112_1314_1516_1718;

    assert_eq!(
        (0x00_u8..=0x0A).map(kind_named).collect::<Vec<_>>(),
        [
            "a parcel",
            "an OPEN",
            "an ACCEPT",
            "a REFUSE",
            "a DATA",
            "a PING",
            "a PONG",
            "a CLOSE",
            "a RESET",
            "a GONE",
            "a parcel"
        ],
        "each kind named"
    );

    // * an advisory kind, whatever its flags and its body, taken in its order: a sequence it needs
    let advisory = read_of(&Parcel {
        flags: Some(0x08),
        opener: HALF,
        acceptor: HALF,
        sequence: 3,
        ..Parcel::of(0x80)
    });

    assert!(
        matches!(
            advisory,
            ParcelRead::Parcel(Parcel {
                kind: 0x80,
                sequence: 3,
                ..
            })
        ),
        "read to its prefix: {advisory:?}"
    );

    for sequence in [0, 1_u64 << 53] {
        let refused = read_of(&Parcel {
            opener: HALF,
            acceptor: HALF,
            sequence,
            ..Parcel::of(0x80)
        });

        assert!(
            matches!(refused, ParcelRead::DoesNotRead(_, ref why) if why == "an advisory parcel with no sequence"),
            "{sequence}: {refused:?}"
        );
    }
}
