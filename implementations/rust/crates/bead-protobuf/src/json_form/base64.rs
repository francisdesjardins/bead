//! `bytes` as Bead's mapping reads and writes them (spec/transcoding.md 5.3.6, 5.6.6): base64 of
//! one alphabet, the standard's or the URL-safe one, padded correctly or not at all, read; the
//! standard alphabet, padded, written.

const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// Why a text is no base64 of `bytes`: its reason, transcoding 5's words.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Base64Refusal {
    /// A character of neither alphabet, or of both.
    Alphabet,
    /// Padded wrongly.
    Padding,
}

impl Base64Refusal {
    pub(crate) const fn reason(self) -> &'static str {
        match self {
            Self::Alphabet => "bytes of no one alphabet of base64",
            Self::Padding => "bytes padded wrongly",
        }
    }
}

// a character's six bits, the URL-safe alphabet's `-` and `_` beside the standard's `+` and `/`
fn sextet_of(character: u8) -> Option<u32> {
    match character {
        b'A'..=b'Z' => Some(u32::from(character.saturating_sub(b'A'))),
        b'a'..=b'z' => Some(u32::from(character.saturating_sub(b'a')).saturating_add(26)),
        b'0'..=b'9' => Some(u32::from(character.saturating_sub(b'0')).saturating_add(52)),
        b'+' | b'-' => Some(62),
        b'/' | b'_' => Some(63),
        _ => None,
    }
}

/// The bytes of `text`, the bits its last character holds past its bytes whatever they are.
pub(crate) fn bytes_of_base64(text: &str) -> Result<Vec<u8>, Base64Refusal> {
    let body = text.trim_end_matches('=');
    let padding = text.len().saturating_sub(body.len());
    let bytes = body.as_bytes();
    let is_standard = bytes.iter().any(|byte| matches!(byte, b'+' | b'/'));
    let is_url_safe = bytes.iter().any(|byte| matches!(byte, b'-' | b'_'));

    if bytes.iter().any(|byte| sextet_of(*byte).is_none()) || (is_standard && is_url_safe) {
        return Err(Base64Refusal::Alphabet);
    }

    let rest = bytes.len() % 4;

    if rest == 1 || (padding > 0 && (padding > 2 || rest.saturating_add(padding) != 4)) {
        return Err(Base64Refusal::Padding);
    }

    let mut decoded = Vec::with_capacity(bytes.len().saturating_mul(3) / 4);
    let mut bits = 0_u32;
    let mut count = 0_u32;

    for byte in bytes {
        bits = (bits << 6) | sextet_of(*byte).unwrap_or_default();
        count = count.saturating_add(6);

        if count >= 8 {
            count = count.saturating_sub(8);
            decoded.extend(u8::try_from((bits >> count) & 0xFF).ok());
        }

        bits &= 0xFF;
    }

    Ok(decoded)
}

/// `bytes` in standard base64, padded (5.6.6).
pub(crate) fn base64_of(bytes: &[u8]) -> String {
    let mut text = String::with_capacity(bytes.len().div_ceil(3).saturating_mul(4));

    for chunk in bytes.chunks(3) {
        let triple = chunk
            .iter()
            .enumerate()
            .fold(0_u32, |triple, (index, byte)| {
                triple | (u32::from(*byte) << (16_usize.saturating_sub(index.saturating_mul(8))))
            });
        let character = |shift: u32| {
            usize::try_from((triple >> shift) & 63)
                .ok()
                .and_then(|sextet| ALPHABET.get(sextet))
                .map_or('=', |byte| char::from(*byte))
        };

        text.push(character(18));
        text.push(character(12));
        text.push(if chunk.len() > 1 { character(6) } else { '=' });
        text.push(if chunk.len() > 2 { character(0) } else { '=' });
    }

    text
}
