//! A parcel (spec 15.17): one message of a broker, and each message one parcel. Its 28 bytes of
//! prefix, which every layout keeps — its layout, its kind, its flags, a byte kept, its opener's
//! half and its acceptor's, its sequence — then its body by its kind. It reads every parcel a side
//! reads, a layout to come to its prefix and, of an OPEN, its id, a REFUSE whole, and refuses each
//! that does not read, saying why; it writes none it would refuse.

use bytes::Bytes;

use crate::errors::ProgrammerError;
use crate::transport::is_field_value;

/// The layout this side writes and reads whole: `0xB1`; `0xB2` to `0xBF` are the layouts to come.
pub(crate) const LAYOUT: u8 = 0xB1;

/// The last layout to come a parcel's first byte may name.
pub(crate) const LAST_LAYOUT: u8 = 0xBF;

/// The bytes of every parcel's prefix.
pub(crate) const PREFIX_BYTES: usize = 28;

/// The largest sequence (spec 1.2): 2⁵³ − 1.
pub(crate) const LARGEST_SEQUENCE: u64 = (1 << 53) - 1;

/// The least receive bound an OPEN or an ACCEPT announces (spec 15.18).
pub(crate) const LEAST_BOUND: u64 = 1_024;

/// The largest receive bound its field holds.
pub(crate) const LARGEST_BOUND: u64 = 0xFFFF_FFFF;

/// The longest a token is, in characters (spec 15.16).
pub(crate) const LONGEST_TOKEN: usize = 64;

/// An incarnation's bytes: what a participant draws each time its link connects.
const INCARNATION_BYTES: usize = 16;

// why a body does not read as its kind's, by its length
const SHORTER: &str = "a body shorter than its kind's";
const LONGER: &str = "a body longer than its kind's";

/// The kinds of a parcel, its byte 1: 0x00 is never one, 0x0A to 0x7F are the kinds to come, and
/// 0x80 to 0xFF are advisory, taken in their order and skipped.
pub(crate) mod kinds {
    /// A client's, to a server's name: the connection's first leg.
    pub(crate) const OPEN: u8 = 0x01;
    /// A server's, to the client's inbox: the second leg.
    pub(crate) const ACCEPT: u8 = 0x02;
    /// A server's, to the client's inbox: the OPEN refused.
    pub(crate) const REFUSE: u8 = 0x03;
    /// Either end's: an envelope, or a part of one.
    pub(crate) const DATA: u8 = 0x04;
    /// Either end's: the heartbeat's ping, and the client's third leg.
    pub(crate) const PING: u8 = 0x05;
    /// Either end's: a ping answered.
    pub(crate) const PONG: u8 = 0x06;
    /// Either end's: the connection's end, sequenced.
    pub(crate) const CLOSE: u8 = 0x07;
    /// Either end's: the connection's end at once, unsequenced.
    pub(crate) const RESET: u8 = 0x08;
    /// A broker's, as a participant's will: its incarnation gone.
    pub(crate) const GONE: u8 = 0x09;
    /// The first advisory kind: one is taken in its order and skipped.
    pub(crate) const FIRST_ADVISORY: u8 = 0x80;
}

/// The flags of a parcel, its byte 2.
pub(crate) mod flags {
    /// On a DATA: another part of its envelope comes after it.
    pub(crate) const MORE: u8 = 0x01;
    /// On a DATA: a credential comes before its envelope.
    pub(crate) const CREDENTIAL: u8 = 0x02;
    /// On an OPEN and an ACCEPT: its sender's own leg is secure (spec 15.22).
    pub(crate) const SECURE: u8 = 0x04;
}

/// A CLOSE's codes, a WebSocket's (RFC 6455 §7.4.1), 4000 and 4001 of its private range.
pub(crate) mod codes {
    /// A clean end.
    pub(crate) const NORMAL: u16 = 1_000;
    /// Its end going away: a server's stop.
    pub(crate) const GOING_AWAY: u16 = 1_001;
    /// A parcel its end refuses.
    pub(crate) const PROTOCOL_ERROR: u16 = 1_002;
    /// An envelope's parts past their bound.
    pub(crate) const TOO_BIG: u16 = 1_009;
    /// A parcel lost, or a bound passed.
    pub(crate) const LOST: u16 = 4_000;
    /// A ping left unanswered.
    pub(crate) const UNANSWERED: u16 = 4_001;
}

// the codes a CLOSE carries
const CODES: [u16; 6] = [
    codes::NORMAL,
    codes::GOING_AWAY,
    codes::PROTOCOL_ERROR,
    codes::TOO_BIG,
    codes::LOST,
    codes::UNANSWERED,
];

/// A REFUSE's statuses, each with the reason it is told by (spec 15.18): 400 `malformed`, 426
/// `layout-refused`, 503 `busy`.
pub(crate) fn refuse_reason_of(status: u16) -> Option<&'static str> {
    match status {
        400 => Some("malformed"),
        426 => Some("layout-refused"),
        503 => Some("busy"),
        _ => None,
    }
}

/// One parcel, by its fields: its prefix, its flags — none for a parcel read to its prefix alone,
/// an advisory one or one of a layout to come — and its body's fields, each of the kinds that have
/// it. A field its kind has no part for is left out.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Parcel {
    /// Its layout, `0xB1`; `0xB2` to `0xBF` the layouts to come, which a side reads to their prefix.
    pub(crate) layout: u8,
    /// Its kind, one of [`kinds`].
    pub(crate) kind: u8,
    /// Its flags, of [`flags`]; none where it was read to its prefix alone.
    pub(crate) flags: Option<u8>,
    /// The opener's half, its 8 bytes big-endian; zero on a GONE.
    pub(crate) opener: u64,
    /// The acceptor's half; zero on an OPEN, a REFUSE and a GONE.
    pub(crate) acceptor: u64,
    /// Its sequence, from 1 in each direction, at most 2⁵³ − 1; 0 on a RESET and a GONE.
    pub(crate) sequence: u64,
    /// An OPEN's, an ACCEPT's or a GONE's: its participant's id, a character a byte.
    pub(crate) id: Option<String>,
    /// An OPEN's, an ACCEPT's or a GONE's: its participant's incarnation, its 16 bytes big-endian.
    pub(crate) incarnation: Option<u128>,
    /// An OPEN's or an ACCEPT's: the largest parcel its sender's inbox takes whole.
    pub(crate) bound: Option<u64>,
    /// A REFUSE's: 400 malformed, 426 layout-refused or 503 busy.
    pub(crate) status: Option<u16>,
    /// A REFUSE 426's: the layouts its sender reads, a byte each.
    pub(crate) layouts: Option<Vec<u8>>,
    /// A DATA's: the credential it carries beside its envelope, on the first part alone.
    pub(crate) credential: Option<String>,
    /// A DATA's: the envelope it carries, or the part of one.
    pub(crate) carried: Option<Bytes>,
    /// A PONG's: the sequence of the PING it answers.
    pub(crate) answers: Option<u64>,
    /// A CLOSE's: its code, a WebSocket's (RFC 6455 §7.4.1).
    pub(crate) code: Option<u16>,
}

impl Parcel {
    /// A parcel of layout `0xB1` and `kind`, every other field none or zero.
    pub(crate) const fn of(kind: u8) -> Self {
        Self {
            layout: LAYOUT,
            kind,
            flags: None,
            opener: 0,
            acceptor: 0,
            sequence: 0,
            id: None,
            incarnation: None,
            bound: None,
            status: None,
            layouts: None,
            credential: None,
            carried: None,
            answers: None,
            code: None,
        }
    }

    /// Whether it is marked `flag`.
    pub(crate) fn has(&self, flag: u8) -> bool {
        self.flags.unwrap_or(0) & flag != 0
    }
}

/// What a message read as a parcel is: a parcel that reads, of its layout or read to its prefix; no
/// parcel, under 28 bytes or of a first byte outside 0xB1 to 0xBF, which a side drops and reports;
/// or a parcel that does not read, its prefix kept, which names the connection it closes with 1002.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ParcelRead {
    /// A parcel that reads.
    Parcel(Parcel),
    /// No parcel, and why.
    NoParcel(String),
    /// A parcel that does not read: its prefix, and why.
    DoesNotRead(Parcel, String),
}

/// Whether `text` is a token: 1 to 64 characters of base64url's alphabet (RFC 4648 §5).
pub(crate) fn is_token(text: &str) -> bool {
    !text.is_empty()
        && text.len() <= LONGEST_TOKEN
        && text
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

/// Whether `layout` is one a parcel's first byte may be: 0xB1 to 0xBF.
pub(crate) fn is_layout(layout: u8) -> bool {
    (LAYOUT..=LAST_LAYOUT).contains(&layout)
}

/// Whether `kind` is advisory: taken in its order and skipped, whatever it holds.
pub(crate) fn is_advisory(kind: u8) -> bool {
    kind >= kinds::FIRST_ADVISORY
}

/// Whether `kind` is one to come: a parcel of one, taken in its order, closes its connection.
pub(crate) fn is_kind_to_come(kind: u8) -> bool {
    kind > kinds::GONE && kind < kinds::FIRST_ADVISORY
}

/// A byte as a report writes it, as the spec does: `0xB1`, two digits in capitals.
pub(crate) fn hex_of_byte(byte: u8) -> String {
    format!("0x{byte:02X}")
}

/// A kind as a report names it, its article before it: `an OPEN`, `a DATA`; `a parcel` for none.
pub(crate) fn kind_named(kind: u8) -> &'static str {
    match kind {
        kinds::OPEN => "an OPEN",
        kinds::ACCEPT => "an ACCEPT",
        kinds::REFUSE => "a REFUSE",
        kinds::DATA => "a DATA",
        kinds::PING => "a PING",
        kinds::PONG => "a PONG",
        kinds::CLOSE => "a CLOSE",
        kinds::RESET => "a RESET",
        kinds::GONE => "a GONE",
        _ => "a parcel",
    }
}

// a string a character a byte, as an id and a credential are read
fn latin1_of(bytes: &[u8]) -> String {
    bytes.iter().copied().map(char::from).collect()
}

// ! a string a character a byte, as an id and a credential are written: one past U+00FF is refused,
// never written as a stand-in
fn bytes_of_latin1((text, what): (&str, &str)) -> Result<Vec<u8>, ProgrammerError> {
    text.chars()
        .map(|character| u8::try_from(u32::from(character)).ok())
        .collect::<Option<Vec<u8>>>()
        .ok_or_else(|| {
            ProgrammerError::new(format!(
                "{what} is written a character a byte, not \"{text}\""
            ))
        })
}

// the flags each kind takes
fn flags_of(kind: u8) -> u8 {
    match kind {
        kinds::DATA => flags::MORE | flags::CREDENTIAL,
        kinds::OPEN | kinds::ACCEPT => flags::SECURE,
        _ => 0,
    }
}

// a big-endian number of `N` bytes at `at`, none past the bytes
fn array_at<const N: usize>(bytes: &[u8], at: usize) -> Option<[u8; N]> {
    bytes
        .get(at..at.checked_add(N)?)
        .and_then(|slice| <[u8; N]>::try_from(slice).ok())
}

fn u16_at(bytes: &[u8], at: usize) -> Option<u16> {
    array_at::<2>(bytes, at).map(u16::from_be_bytes)
}

fn u32_at(bytes: &[u8], at: usize) -> Option<u32> {
    array_at::<4>(bytes, at).map(u32::from_be_bytes)
}

fn u64_at(bytes: &[u8], at: usize) -> Option<u64> {
    array_at::<8>(bytes, at).map(u64::from_be_bytes)
}

fn u128_at(bytes: &[u8], at: usize) -> Option<u128> {
    array_at::<16>(bytes, at).map(u128::from_be_bytes)
}

fn refused(prefix: Parcel, why: &str) -> ParcelRead {
    ParcelRead::DoesNotRead(prefix, why.to_owned())
}

/// Reads a message as a parcel (spec 15.17): no parcel, under 28 bytes or of a first byte outside
/// 0xB1 to 0xBF; a layout to come read to its prefix, an OPEN's id beside it and a REFUSE whole; an
/// advisory kind read to its prefix, whatever its flags, its kept byte and its body; any other read
/// whole, or refused, its prefix kept.
pub(crate) fn read_parcel(message: &Bytes) -> ParcelRead {
    let bytes = message.as_ref();

    if bytes.len() < PREFIX_BYTES {
        return ParcelRead::NoParcel(format!(
            "{} bytes, under a parcel's {PREFIX_BYTES}",
            bytes.len()
        ));
    }

    let (Some(&layout), Some(&kind), Some(&flag_byte), Some(&kept)) =
        (bytes.first(), bytes.get(1), bytes.get(2), bytes.get(3))
    else {
        return ParcelRead::NoParcel("a parcel's prefix runs past its bytes".to_owned());
    };

    if !is_layout(layout) {
        return ParcelRead::NoParcel(format!(
            "a first byte of {}, outside 0xB1 to 0xBF",
            hex_of_byte(layout)
        ));
    }

    let prefix = Parcel {
        layout,
        kind,
        flags: None,
        opener: u64_at(bytes, 4).unwrap_or(0),
        acceptor: u64_at(bytes, 12).unwrap_or(0),
        sequence: u64_at(bytes, 20).unwrap_or(0),
        ..Parcel::of(kind)
    };
    let body = message.slice(PREFIX_BYTES..);

    if layout != LAYOUT {
        return read_to_come((prefix, body), (flag_byte, kept));
    }

    read_of_layout((prefix, body), (flag_byte, kept))
}

// a parcel of layout 0xB1, read whole: an advisory kind to its prefix, whatever its flags, its kept
// byte and its body; any other by its kind, its flags, its kept byte, its prefix, then its body
fn read_of_layout((prefix, body): (Parcel, Bytes), (flag_byte, kept): (u8, u8)) -> ParcelRead {
    let kind = prefix.kind;

    if is_advisory(kind) {
        // * whatever its flags, its kept byte and its body: taken in its order, and skipped
        return if prefix.sequence == 0 || prefix.sequence > LARGEST_SEQUENCE {
            refused(prefix, "an advisory parcel with no sequence")
        } else {
            ParcelRead::Parcel(prefix)
        };
    }

    if kind == 0 {
        return refused(prefix, "a kind of 0x00, never one");
    }

    if is_kind_to_come(kind) {
        let why = format!("a kind to come, {}", hex_of_byte(kind));

        return refused(prefix, &why);
    }

    if flag_byte & !flags_of(kind) != 0 {
        let why = format!("a flag {} does not take", kind_named(kind));

        return refused(prefix, &why);
    }

    if kept != 0 {
        return refused(prefix, "a kept byte that is not 0");
    }

    if let Some(fault) = prefix_fault_of(&prefix) {
        return refused(prefix, &fault);
    }

    read_body(
        Parcel {
            flags: Some(flag_byte),
            ..prefix
        },
        &body,
    )
}

// why a prefix of layout 0xB1 does not read as its kind's: its sequence, then its halves; or none
fn prefix_fault_of(prefix: &Parcel) -> Option<String> {
    if prefix.sequence > LARGEST_SEQUENCE {
        return Some("a sequence past 2⁵³ − 1".to_owned());
    }

    let is_unsequenced = matches!(prefix.kind, kinds::RESET | kinds::GONE);

    if is_unsequenced != (prefix.sequence == 0) {
        return Some(if is_unsequenced {
            format!("{} with a sequence", kind_named(prefix.kind))
        } else {
            "a sequence of 0".to_owned()
        });
    }

    if prefix.kind == kinds::GONE {
        return (prefix.opener != 0 || prefix.acceptor != 0)
            .then(|| "a GONE naming a half".to_owned());
    }

    if prefix.opener == 0 {
        return Some("an opener's half all zero".to_owned());
    }

    let names_no_acceptor = matches!(prefix.kind, kinds::OPEN | kinds::REFUSE);

    (names_no_acceptor != (prefix.acceptor == 0)).then(|| {
        if names_no_acceptor {
            "an acceptor's half where it names none".to_owned()
        } else {
            "an acceptor's half all zero".to_owned()
        }
    })
}

// a layout to come, read as every layout keeps it: its prefix; an OPEN's id at the head of its
// body; a REFUSE whole
fn read_to_come((prefix, body): (Parcel, Bytes), (flag_byte, kept): (u8, u8)) -> ParcelRead {
    if prefix.kind == kinds::OPEN {
        let length = body.first().map(|length| usize::from(*length));
        let id = length.and_then(|length| body.get(1..length.checked_add(1)?));

        return match id {
            Some(id) => ParcelRead::Parcel(Parcel {
                id: Some(latin1_of(id)),
                ..prefix
            }),
            None => refused(prefix, "an OPEN whose id runs past its bytes"),
        };
    }

    if prefix.kind != kinds::REFUSE {
        return ParcelRead::Parcel(prefix);
    }

    // * a REFUSE every layout keeps: read as its own, its layout kept
    let layout = prefix.layout;

    match read_of_layout(
        (
            Parcel {
                layout: LAYOUT,
                ..prefix
            },
            body,
        ),
        (flag_byte, kept),
    ) {
        ParcelRead::Parcel(parcel) => ParcelRead::Parcel(Parcel { layout, ..parcel }),
        ParcelRead::DoesNotRead(parcel, why) => {
            ParcelRead::DoesNotRead(Parcel { layout, ..parcel }, why)
        }
        no_parcel @ ParcelRead::NoParcel(_) => no_parcel,
    }
}

// a parcel's body by its kind, read whole: exactly its kind's, or refused saying why
#[expect(
    clippy::too_many_lines,
    reason = "each kind's body read in its order, as the other sides read it, one match"
)]
fn read_body(prefix: Parcel, body: &Bytes) -> ParcelRead {
    let span = body.as_ref();
    let length = span.len();

    match prefix.kind {
        kinds::OPEN | kinds::ACCEPT => {
            let id_length = span.first().map(|length| usize::from(*length));
            let Some((id_length, end)) = id_length.and_then(|id_length| {
                Some((id_length, id_length.checked_add(1 + INCARNATION_BYTES + 4)?))
            }) else {
                return refused(prefix, SHORTER);
            };

            if length < end {
                return refused(prefix, SHORTER);
            }

            let id = latin1_of(span.get(1..=id_length).unwrap_or_default());
            let incarnation = u128_at(span, id_length.saturating_add(1));
            let bound = u32_at(span, id_length.saturating_add(1 + INCARNATION_BYTES));

            // ! an OPEN's id that is no token, or its bound under 1,024, is its acceptor's to
            // refuse 400 (spec 15.18); an ACCEPT's does not read
            if prefix.kind == kinds::ACCEPT && !is_token(&id) {
                return refused(prefix, "an id that is no token");
            }

            if prefix.kind == kinds::ACCEPT
                && bound.is_none_or(|bound| u64::from(bound) < LEAST_BOUND)
            {
                return refused(prefix, "a receive bound under 1,024 bytes");
            }

            if length > end {
                return refused(prefix, LONGER);
            }

            ParcelRead::Parcel(Parcel {
                id: Some(id),
                incarnation,
                bound: bound.map(u64::from),
                ..prefix
            })
        }
        kinds::REFUSE => {
            let status = u16_at(span, 0);
            let Some(status) = status.filter(|status| refuse_reason_of(*status).is_some()) else {
                return refused(prefix, "a status a REFUSE does not name");
            };
            let layouts = span.get(2..).unwrap_or_default().to_vec();

            if status != 426 {
                return if layouts.is_empty() {
                    ParcelRead::Parcel(Parcel {
                        status: Some(status),
                        ..prefix
                    })
                } else {
                    refused(prefix, LONGER)
                };
            }

            if !layouts.is_empty() && layouts.iter().all(|layout| is_layout(*layout)) {
                ParcelRead::Parcel(Parcel {
                    status: Some(status),
                    layouts: Some(layouts),
                    ..prefix
                })
            } else {
                refused(prefix, "a 426 that names no layout it reads")
            }
        }
        kinds::DATA => {
            let mut credential = None;
            let mut at = 0;

            if prefix.has(flags::CREDENTIAL) {
                let carried = u16_at(span, 0)
                    .map(usize::from)
                    .filter(|length| *length > 0)
                    .and_then(|length| span.get(2..length.checked_add(2)?));
                let Some(carried) = carried else {
                    return refused(prefix, "a credential that runs past its bytes, or is empty");
                };
                let text = latin1_of(carried);

                at = carried.len().saturating_add(2);

                // a credential is any field value (spec 15.5)
                if !is_field_value(&text) {
                    return refused(prefix, "a credential that is no field value");
                }

                credential = Some(text);
            }

            if length > at {
                ParcelRead::Parcel(Parcel {
                    credential,
                    carried: Some(body.slice(at..)),
                    ..prefix
                })
            } else {
                refused(prefix, "a DATA that carries nothing")
            }
        }
        kinds::PING | kinds::RESET => {
            if length == 0 {
                ParcelRead::Parcel(prefix)
            } else {
                refused(prefix, LONGER)
            }
        }
        kinds::PONG => {
            // ! what it answers is a sequence, 2⁵³ − 1 at most (spec 1.2)
            let Some(answers) = u64_at(span, 0).filter(|answers| *answers <= LARGEST_SEQUENCE)
            else {
                return refused(prefix, "a PONG that answers no sequence");
            };

            if length == 8 {
                ParcelRead::Parcel(Parcel {
                    answers: Some(answers),
                    ..prefix
                })
            } else {
                refused(prefix, LONGER)
            }
        }
        kinds::CLOSE => {
            let Some(code) = u16_at(span, 0).filter(|code| CODES.contains(code)) else {
                return refused(prefix, "a code a CLOSE does not name");
            };

            if length == 2 {
                ParcelRead::Parcel(Parcel {
                    code: Some(code),
                    ..prefix
                })
            } else {
                refused(prefix, LONGER)
            }
        }
        _ => {
            // a GONE: its incarnation, then its id, a token
            let id_length = span
                .get(INCARNATION_BYTES)
                .map(|length| usize::from(*length));
            let Some(end) = id_length.and_then(|id_length| id_length.checked_add(17)) else {
                return refused(prefix, SHORTER);
            };

            if length < end {
                return refused(prefix, SHORTER);
            }

            let id = latin1_of(span.get(17..end).unwrap_or_default());

            if !is_token(&id) {
                return refused(prefix, "an id that is no token");
            }

            if length == end {
                ParcelRead::Parcel(Parcel {
                    incarnation: u128_at(span, 0),
                    id: Some(id),
                    ..prefix
                })
            } else {
                refused(prefix, LONGER)
            }
        }
    }
}

/// The bytes of `parcel`, by its fields, held to nothing but what a byte holds: what a test's own
/// peer writes, a parcel this side refuses among them; [`write_parcel`] holds what a side sends. A
/// DATA that carries a credential is marked `CREDENTIAL`.
///
/// # Errors
///
/// A [`ProgrammerError`] for an id or a credential past U+00FF or past what its length's field
/// holds, or a receive bound past 4 bytes.
pub(crate) fn encode_parcel(parcel: &Parcel) -> Result<Vec<u8>, ProgrammerError> {
    let body = body_of(parcel)?;
    let credential_flag = if parcel.kind == kinds::DATA && parcel.credential.is_some() {
        flags::CREDENTIAL
    } else {
        0
    };
    let mut bytes = Vec::with_capacity(PREFIX_BYTES.saturating_add(body.len()));

    bytes.extend_from_slice(&[
        parcel.layout,
        parcel.kind,
        parcel.flags.unwrap_or(0) | credential_flag,
        0,
    ]);
    bytes.extend_from_slice(&parcel.opener.to_be_bytes());
    bytes.extend_from_slice(&parcel.acceptor.to_be_bytes());
    bytes.extend_from_slice(&parcel.sequence.to_be_bytes());
    bytes.extend_from_slice(&body);

    Ok(bytes)
}

/// Writes a parcel of layout `0xB1` from its fields (spec 15.17): its flags those given, `MORE`
/// and `CREDENTIAL` on a DATA, a credential beside its `carried` when one is given. No parcel is
/// written that a side refuses.
///
/// # Errors
///
/// A [`ProgrammerError`] for one that would not read back, an advisory kind, a kind to come, a
/// layout other than `0xB1`, or an OPEN its acceptor refuses 400 (spec 15.18).
pub(crate) fn write_parcel(parcel: &Parcel) -> Result<Bytes, ProgrammerError> {
    // ! what a side reads and no writer writes: a layout to come, an advisory kind, and an OPEN its
    // acceptor refuses 400 (spec 15.18)
    if parcel.layout != LAYOUT || parcel.kind == 0 || parcel.kind > kinds::GONE {
        return Err(ProgrammerError::new(format!(
            "a parcel of the layout {} and the kind {} is read, never written",
            hex_of_byte(parcel.layout),
            hex_of_byte(parcel.kind)
        )));
    }

    if matches!(parcel.kind, kinds::OPEN | kinds::ACCEPT) {
        let id = parcel.id.as_deref().unwrap_or_default();
        let bound = parcel.bound.unwrap_or(0);

        if !is_token(id) || !(LEAST_BOUND..=LARGEST_BOUND).contains(&bound) {
            return Err(ProgrammerError::new(format!(
                "{} names a token and a receive bound of 1,024 bytes at least",
                kind_named(parcel.kind)
            )));
        }
    }

    let bytes = Bytes::from(encode_parcel(parcel)?);

    // ! read back: what does not read as written is no parcel this side may send
    match read_parcel(&bytes) {
        ParcelRead::Parcel(read) if read.layout == LAYOUT => Ok(bytes),
        ParcelRead::Parcel(_) => Err(ProgrammerError::new(
            "a parcel this side refuses is never written: a layout to come",
        )),
        ParcelRead::NoParcel(why) | ParcelRead::DoesNotRead(_, why) => Err(ProgrammerError::new(
            format!("a parcel this side refuses is never written: {why}"),
        )),
    }
}

// an id's length on a byte, then the id
fn id_bytes_of(id: Option<&str>) -> Result<Vec<u8>, ProgrammerError> {
    let id = bytes_of_latin1((id.unwrap_or_default(), "an id"))?;
    let length = u8::try_from(id.len())
        .map_err(|_past| ProgrammerError::new("an id is 255 bytes at most"))?;
    let mut bytes = Vec::with_capacity(id.len().saturating_add(1));

    bytes.push(length);
    bytes.extend_from_slice(&id);

    Ok(bytes)
}

// a parcel's body, by its kind, as `read_body` reads it
fn body_of(parcel: &Parcel) -> Result<Vec<u8>, ProgrammerError> {
    let mut body = Vec::new();

    match parcel.kind {
        kinds::OPEN | kinds::ACCEPT => {
            let bound = u32::try_from(parcel.bound.unwrap_or(0))
                .map_err(|_past| ProgrammerError::new("a receive bound is one of 4 bytes"))?;

            body.extend_from_slice(&id_bytes_of(parcel.id.as_deref())?);
            body.extend_from_slice(&parcel.incarnation.unwrap_or(0).to_be_bytes());
            body.extend_from_slice(&bound.to_be_bytes());
        }
        kinds::REFUSE => {
            body.extend_from_slice(&parcel.status.unwrap_or(0).to_be_bytes());
            body.extend_from_slice(parcel.layouts.as_deref().unwrap_or_default());
        }
        kinds::DATA => {
            if let Some(credential) = &parcel.credential {
                let credential = bytes_of_latin1((credential, "a credential"))?;
                let length = u16::try_from(credential.len()).map_err(|_past| {
                    ProgrammerError::new("a credential is 65,535 bytes at most")
                })?;

                body.extend_from_slice(&length.to_be_bytes());
                body.extend_from_slice(&credential);
            }

            body.extend_from_slice(parcel.carried.as_deref().unwrap_or_default());
        }
        kinds::PONG => body.extend_from_slice(&parcel.answers.unwrap_or(0).to_be_bytes()),
        kinds::CLOSE => body.extend_from_slice(&parcel.code.unwrap_or(0).to_be_bytes()),
        kinds::GONE => {
            body.extend_from_slice(&parcel.incarnation.unwrap_or(0).to_be_bytes());
            body.extend_from_slice(&id_bytes_of(parcel.id.as_deref())?);
        }
        _ => {}
    }

    Ok(body)
}
