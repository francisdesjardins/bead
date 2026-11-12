//! A host as the WHATWG URL Standard's host parser reads it for a special scheme's URL.
//!
//! As the W3C's Secure Contexts reads an origin by it, and as that standard serializes it: a domain
//! in ASCII lower case, by UTS #46's `ToASCII`, an IPv4 address in its four decimal numbers, an
//! IPv6 one bracketed and compressed. The other sides read a host alike: the TypeScript side by its
//! platform's `URL`, the C# side by its `UrlHost`.

use std::borrow::Cow;

use idna::AsciiDenyList;

#[cfg(test)]
mod tests;

// the largest an IPv4 number need be told from: past it, every address it is part of fails
const PAST: u64 = 1 << 40;

// what stands for a position past a text's end, as the URL Standard's EOF code point
const END: char = '\u{ffff}';

// the bytes of `text`'s UTF-8, each %XX of two hex digits read as the byte it spells, read back as
// UTF-8, what does not read as UTF-8 replaced
fn percent_decoded_of(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0_usize;

    while let Some(&byte) = bytes.get(index) {
        let spelled = (byte == b'%')
            .then(|| bytes.get(index.saturating_add(1)..index.saturating_add(3)))
            .flatten()
            .and_then(|digits| core::str::from_utf8(digits).ok())
            .filter(|digits| digits.bytes().all(|digit| digit.is_ascii_hexdigit()))
            .and_then(|digits| u8::from_str_radix(digits, 16).ok());

        if let Some(spelled) = spelled {
            decoded.push(spelled);
            index = index.saturating_add(3);
        } else {
            decoded.push(byte);
            index = index.saturating_add(1);
        }
    }

    String::from_utf8_lossy(&decoded).into_owned()
}

// a domain in ASCII, as the URL Standard's domain to ASCII gives it when it is not strict: UTS #46's
// ToASCII, its forbidden domain code points refused; none when it fails
fn ascii_domain_of(domain: &str) -> Option<String> {
    let ascii = idna::domain_to_ascii_cow(domain.as_bytes(), AsciiDenyList::URL).ok()?;

    (!ascii.is_empty()).then(|| Cow::into_owned(ascii))
}

// a part of an IPv4 address: decimal, hexadecimal after 0x, octal after 0; none when it is not a
// number, and past every address beyond PAST
fn number_of(part: &str) -> Option<u64> {
    if part.is_empty() {
        return None;
    }

    let hexadecimal = part.strip_prefix("0x").or_else(|| part.strip_prefix("0X"));
    let octal = part.strip_prefix('0').filter(|digits| !digits.is_empty());
    let (radix, digits) = match (hexadecimal, octal) {
        (Some(digits), _) => (16, digits),
        (None, Some(digits)) => (8, digits),
        (None, None) => (10, part),
    };
    let mut value = 0_u64;

    for digit in digits.chars() {
        let weight = u64::from(digit.to_digit(radix)?);

        value = value
            .saturating_mul(u64::from(radix))
            .saturating_add(weight)
            .min(PAST);
    }

    Some(value)
}

// the parts of a domain split at its dots, one empty part after the last dot dropped
fn parts_of(domain: &str) -> Vec<&str> {
    let mut parts: Vec<&str> = domain.split('.').collect();

    if parts.len() > 1 && parts.last().is_some_and(|last| last.is_empty()) {
        parts.pop();
    }

    parts
}

// whether a domain ends in a number, which makes it an IPv4 address or nothing
fn ends_in_a_number(domain: &str) -> bool {
    let parts = parts_of(domain);
    let Some(last) = parts.last().filter(|last| !last.is_empty()) else {
        return false;
    };

    last.bytes().all(|byte| byte.is_ascii_digit())
        || ((last.starts_with("0x") || last.starts_with("0X")) && number_of(last).is_some())
}

// an IPv4 address of one to four numbers, the last filling what the others leave, one dot after
// them taken; none when it is not one
fn ipv4_of(domain: &str) -> Option<String> {
    let parts = parts_of(domain);

    if parts.len() > 4 {
        return None;
    }

    let numbers = parts
        .iter()
        .map(|part| number_of(part))
        .collect::<Option<Vec<u64>>>()?;
    let (last, first) = numbers.split_last()?;
    // the bits the last number fills: 8 for each part it is not
    let room = u32::try_from(5_usize.saturating_sub(numbers.len()))
        .ok()?
        .saturating_mul(8);

    if first.iter().any(|number| *number > 255) || *last >= 1_u64.checked_shl(room)? {
        return None;
    }

    let mut address = *last;

    for (index, number) in (0_u32..).zip(first) {
        address = address
            .saturating_add(number.checked_shl(8_u32.saturating_mul(3_u32.saturating_sub(index)))?);
    }

    let octets = address.to_be_bytes();
    let [.., first, second, third, fourth] = octets;

    Some(format!("{first}.{second}.{third}.{fourth}"))
}

// an IPv6 address's eight pieces, as the URL Standard's IPv6 parser reads one: hexadecimal pieces,
// one :: at most, an IPv4 address of four decimal numbers in its last 32 bits; none when it is not
// one
#[expect(
    clippy::too_many_lines,
    reason = "the URL Standard's IPv6 parser, step for step, as the C# side's UrlHost writes it"
)]
fn ipv6_of(text: &str) -> Option<[u16; 8]> {
    let characters: Vec<char> = text.chars().collect();
    let at = |index: usize| characters.get(index).copied().unwrap_or(END);
    let length = characters.len();
    let mut address = [0_u16; 8];
    let mut piece_index = 0_usize;
    let mut compress: Option<usize> = None;
    let mut pointer = 0_usize;

    if at(pointer) == ':' {
        if at(pointer.saturating_add(1)) != ':' {
            return None;
        }

        pointer = pointer.saturating_add(2);
        piece_index = piece_index.saturating_add(1);
        compress = Some(piece_index);
    }

    while pointer < length {
        if piece_index == 8 {
            return None;
        }

        if at(pointer) == ':' {
            if compress.is_some() {
                return None;
            }

            pointer = pointer.saturating_add(1);
            piece_index = piece_index.saturating_add(1);
            compress = Some(piece_index);

            continue;
        }

        let mut value = 0_u16;
        let mut digits = 0_usize;

        while digits < 4
            && let Some(digit) = at(pointer).to_digit(16)
        {
            value = value
                .saturating_mul(0x10)
                .saturating_add(u16::try_from(digit).ok()?);
            pointer = pointer.saturating_add(1);
            digits = digits.saturating_add(1);
        }

        if at(pointer) == '.' {
            if digits == 0 || piece_index > 6 {
                return None;
            }

            pointer = pointer.saturating_sub(digits);

            let mut numbers_seen = 0_usize;

            while pointer < length {
                let mut piece: Option<u16> = None;

                if numbers_seen > 0 {
                    if at(pointer) != '.' || numbers_seen >= 4 {
                        return None;
                    }

                    pointer = pointer.saturating_add(1);
                }

                if !at(pointer).is_ascii_digit() {
                    return None;
                }

                while let Some(number) = at(pointer).to_digit(10) {
                    if piece == Some(0) {
                        return None;
                    }

                    let next = piece
                        .unwrap_or(0)
                        .saturating_mul(10)
                        .saturating_add(u16::try_from(number).ok()?);

                    if next > 255 {
                        return None;
                    }

                    piece = Some(next);
                    pointer = pointer.saturating_add(1);
                }

                let slot = address.get_mut(piece_index)?;

                *slot = slot.saturating_mul(0x100).saturating_add(piece?);
                numbers_seen = numbers_seen.saturating_add(1);

                if numbers_seen == 2 || numbers_seen == 4 {
                    piece_index = piece_index.saturating_add(1);
                }
            }

            if numbers_seen != 4 {
                return None;
            }

            break;
        }

        if at(pointer) == ':' {
            pointer = pointer.saturating_add(1);

            if pointer >= length {
                return None;
            }
        } else if pointer < length {
            return None;
        }

        *address.get_mut(piece_index)? = value;
        piece_index = piece_index.saturating_add(1);
    }

    if let Some(compressed) = compress {
        let mut swaps = piece_index.saturating_sub(compressed);

        piece_index = 7;

        while piece_index != 0 && swaps > 0 {
            let other = compressed.saturating_add(swaps).saturating_sub(1);

            // WHATWG URL's IPv6 parser swaps two pieces of the eight; the same one twice is no swap
            if piece_index != other {
                let [one, two] = address.get_disjoint_mut([piece_index, other]).ok()?;

                core::mem::swap(one, two);
            }
            piece_index = piece_index.saturating_sub(1);
            swaps = swaps.saturating_sub(1);
        }
    } else if piece_index != 8 {
        return None;
    }

    Some(address)
}

// an IPv6 address as the URL Standard serializes it: bracketed, its pieces in lower-case hex, the
// first longest run of two zero pieces or more written ::
fn serialized_of(address: [u16; 8]) -> String {
    let mut compressed: Option<(usize, usize)> = None;
    let mut longest = 1_usize;

    for start in 0..8 {
        let run = address
            .iter()
            .skip(start)
            .take_while(|piece| **piece == 0)
            .count();

        if run > longest {
            compressed = Some((start, run));
            longest = run;
        }
    }

    let mut text = String::from("[");
    let mut index = 0_usize;

    while let Some(piece) = address.get(index) {
        if let Some((start, run)) = compressed
            && index == start
        {
            text.push_str(if index == 0 { "::" } else { ":" });
            index = index.saturating_add(run);

            continue;
        }

        let hex = format!("{piece:x}");

        text.push_str(&hex);

        if index < 7 {
            text.push(':');
        }

        index = index.saturating_add(1);
    }

    text.push(']');
    text
}

/// The host `input` is, as the URL Standard's host parser reads it for a special scheme's URL and
/// serializes it; none where that parser fails: a host that holds a space, say.
#[must_use]
pub fn url_host_of(input: &str) -> Option<String> {
    if let Some(bracketed) = input.strip_prefix('[') {
        return bracketed
            .strip_suffix(']')
            .and_then(ipv6_of)
            .map(serialized_of);
    }

    if input.is_empty() {
        return None;
    }

    let domain = ascii_domain_of(&percent_decoded_of(input))?;

    if ends_in_a_number(&domain) {
        ipv4_of(&domain)
    } else {
        Some(domain)
    }
}
