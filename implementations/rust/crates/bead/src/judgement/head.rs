//! A request's head read from its bytes under its bounds (RFC 9112 §2-§5), by httparse: its
//! method, its target, its version and its fields, or a refusal.
//!
//! A head is 16 KiB at most, its request line among it, and holds 100 fields at most, as an HTTP
//! server's head holds them (spec 15.12): past either it is refused 431, and a head httparse does
//! not read, a control character in its target or a field's value among it, 400. Each octet past
//! ASCII is the character of its Latin-1 code, as the other sides' platforms hand a head on.

#[cfg(test)]
mod tests;

/// The bytes a request's head holds at most, its request line and its empty line among them.
pub const MAXIMUM_HEAD_BYTES: usize = 16_384;

/// The fields a request's head holds at most.
pub const MAXIMUM_HEAD_FIELDS: usize = 100;

// what a head past its bounds is answered, and one httparse does not read (RFC 9110 §15.5.1,
// RFC 6585 §5)
const PAST_ITS_BOUNDS: u16 = 431;
const MALFORMED: u16 = 400;

/// A request's head, as it came.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub struct Head {
    /// Its method, a token.
    pub method: String,
    /// Its target, as it came.
    pub target: String,
    /// Its version: `1.0` or `1.1`.
    pub http_version: &'static str,
    /// Its fields as they came, each name before its value.
    pub raw_fields: Vec<String>,
    /// The bytes it took, its empty line among them: what follows is the request's.
    pub length: usize,
}

impl Head {
    /// Its fields as [`crate::judgement::handshake::HandshakeRequest`] reads them.
    #[must_use]
    pub fn fields(&self) -> Vec<&str> {
        self.raw_fields.iter().map(String::as_str).collect()
    }
}

/// What a head's bytes read as.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum HeadRead {
    /// A head not whole yet, within its bounds: more is to be read.
    Partial,
    /// A head whole.
    Whole(Head),
    /// A head refused, by the status it is answered: 431 past its bounds, 400 for one HTTP does
    /// not read.
    Refused(u16),
}

// octets as the characters of their Latin-1 codes
fn latin1_of(bytes: &[u8]) -> String {
    bytes.iter().copied().map(char::from).collect()
}

/// A head read from the bytes a connection received, from its first.
#[must_use]
pub fn read_head(bytes: &[u8]) -> HeadRead {
    let mut fields = [httparse::EMPTY_HEADER; MAXIMUM_HEAD_FIELDS];
    let mut request = httparse::Request::new(&mut fields);

    match request.parse(bytes) {
        Ok(httparse::Status::Complete(length)) if length > MAXIMUM_HEAD_BYTES => {
            HeadRead::Refused(PAST_ITS_BOUNDS)
        }
        Ok(httparse::Status::Complete(length)) => {
            let raw_fields = request
                .headers
                .iter()
                .flat_map(|field| [latin1_of(field.name.as_bytes()), latin1_of(field.value)])
                .collect();
            let http_version = match request.version {
                Some(0) => "1.0",
                Some(_) | None => "1.1",
            };

            HeadRead::Whole(Head {
                method: request.method.unwrap_or_default().to_owned(),
                target: latin1_of(request.path.unwrap_or_default().as_bytes()),
                http_version,
                raw_fields,
                length,
            })
        }
        // * a head still coming past its bounds can only end past them
        Ok(httparse::Status::Partial) if bytes.len() >= MAXIMUM_HEAD_BYTES => {
            HeadRead::Refused(PAST_ITS_BOUNDS)
        }
        Ok(httparse::Status::Partial) => HeadRead::Partial,
        Err(httparse::Error::TooManyHeaders) => HeadRead::Refused(PAST_ITS_BOUNDS),
        Err(
            httparse::Error::HeaderName
            | httparse::Error::HeaderValue
            | httparse::Error::NewLine
            | httparse::Error::Status
            | httparse::Error::Token
            | httparse::Error::Version,
        ) => HeadRead::Refused(MALFORMED),
    }
}
