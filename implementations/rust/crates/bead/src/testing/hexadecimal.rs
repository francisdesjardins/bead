//! Bytes in hexadecimal, as the conformance files write them: spaces and bars aside.

/// The bytes `text` spells, spaces and bars aside; none for a character no hexadecimal digit is,
/// or an odd count of digits.
#[must_use]
pub fn bytes_of(text: &str) -> Option<Vec<u8>> {
    let digits: Vec<u8> = text
        .bytes()
        .filter(|byte| !byte.is_ascii_whitespace() && *byte != b'|')
        .collect();

    if !digits.len().is_multiple_of(2) {
        return None;
    }

    digits
        .chunks(2)
        .map(|pair| {
            core::str::from_utf8(pair)
                .ok()
                .and_then(|pair| u8::from_str_radix(pair, 16).ok())
        })
        .collect()
}

/// `bytes` in upper-case hexadecimal, a space between each.
#[must_use]
pub fn text_of(bytes: &[u8]) -> String {
    bytes
        .iter()
        .map(|byte| format!("{byte:02X}"))
        .collect::<Vec<_>>()
        .join(" ")
}
