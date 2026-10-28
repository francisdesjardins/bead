//! Base64url without padding (RFC 4648 §5), strict as both other sides read it: no padding, no
//! character outside its alphabet, and no bit set past the last byte.

// the alphabet, by each 6-bit value
const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

// the 6-bit value of a character of the alphabet
fn value_of(character: u8) -> Option<u32> {
    match character {
        b'A'..=b'Z' => Some(u32::from(character.wrapping_sub(b'A'))),
        b'a'..=b'z' => Some(u32::from(character.wrapping_sub(b'a')).wrapping_add(26)),
        b'0'..=b'9' => Some(u32::from(character.wrapping_sub(b'0')).wrapping_add(52)),
        b'-' => Some(62),
        b'_' => Some(63),
        _ => None,
    }
}

// the character of a 6-bit value
fn character_of(value: u32) -> char {
    usize::try_from(value & 0x3f)
        .ok()
        .and_then(|index| ALPHABET.get(index))
        .map_or('A', |&byte| char::from(byte))
}

/// `bytes` in base64url, unpadded.
pub(crate) fn encode(bytes: &[u8]) -> String {
    let mut text = String::new();

    for group in bytes.chunks(3) {
        let first = u32::from(group.first().copied().unwrap_or(0));
        let second = u32::from(group.get(1).copied().unwrap_or(0));
        let third = u32::from(group.get(2).copied().unwrap_or(0));
        let word = (first << 16) | (second << 8) | third;

        text.push(character_of(word >> 18));
        text.push(character_of(word >> 12));

        if group.len() > 1 {
            text.push(character_of(word >> 6));
        }

        if group.len() > 2 {
            text.push(character_of(word));
        }
    }

    text
}

/// The bytes `text` spells in base64url, unpadded; none for a character outside its alphabet, a
/// length no bytes spell, or a bit set past the last byte.
pub(crate) fn decode(text: &[u8]) -> Option<Vec<u8>> {
    if text.len() % 4 == 1 {
        return None;
    }

    let mut bytes = Vec::with_capacity(text.len().saturating_mul(3) / 4);

    for group in text.chunks(4) {
        let mut word = 0_u32;

        for (index, &character) in group.iter().enumerate() {
            let shift = 18_u32.checked_sub(u32::try_from(index).ok()?.checked_mul(6)?)?;

            word |= value_of(character)?.checked_shl(shift)?;
        }

        let [_, first, second, third] = word.to_be_bytes();

        match group.len() {
            2 => {
                // ! the 4 bits past the one byte two characters spell are zero
                if (second | third) != 0 {
                    return None;
                }

                bytes.push(first);
            }
            3 => {
                if third != 0 {
                    return None;
                }

                bytes.extend([first, second]);
            }
            _ => bytes.extend([first, second, third]),
        }
    }

    Some(bytes)
}
