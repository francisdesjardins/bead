//! A session's token: 16 bytes, never all zero, drawn anew while one is in use, compared in
//! constant time, and written in no `Debug`.

use super::SessionToken;

#[test]
fn spell_16_bytes_in_unpadded_base64url_and_back() {
    let bytes = core::array::from_fn(|index: usize| {
        u8::try_from(index.saturating_mul(17)).expect("a byte")
    });
    let token = SessionToken::new(bytes).expect("the sixteen nonzero bytes");
    let text = token.to_string();
    assert_eq!(text, "ABEiM0RVZneImaq7zN3u_w");
    assert!(is_session_token(&text));
    assert_eq!(
        text.parse::<SessionToken>()
            .expect("the token read")
            .bytes(),
        &bytes
    );
    let high = SessionToken::new([0xFB; 16]).expect("sixteen high bytes");
    assert_eq!(high.to_string(), "-_v7-_v7-_v7-_v7-_v7-w");
    assert_eq!(
        high.to_string()
            .parse::<SessionToken>()
            .expect("the high bytes read")
            .bytes(),
        &[0xFB; 16]
    );
}

#[test]
fn refuse_any_length_but_16_bytes_and_16_zero_bytes() {
    for length in [0, 15, 17] {
        SessionToken::from_slice(&vec![1; length]).expect_err("only sixteen bytes are a token");
    }
    SessionToken::from_slice(&[0; 16]).expect_err("sixteen zero bytes are no token");
}

#[test]
fn are_only_what_the_wire_can_spell() {
    // A parser takes &str: the source's number and undefined cannot be presented to it.
    for text in [
        "",
        "ABEiM0RVZneImaq7zN3u_",
        "ABEiM0RVZneImaq7zN3u_wA",
        "ABEiM0RVZneImaq7zN3u+w",
        "ABEiM0RVZneImaq7zN3u/w",
        "ABEiM0RVZneImaq7zN3u w",
        "ABEiM0RVZneImaq7zN3u_w==",
        "ABEiM0RVZneImaq7zN3uAB",
        "AAAAAAAAAAAAAAAAAAAAAA",
    ] {
        assert!(!is_session_token(text), "{text:?} is no token");
    }
    for last in ['A', 'Q', 'g', 'w'] {
        assert!(is_session_token(&format!("ABEiM0RVZneImaq7zN3u_{last}")));
    }
    for text in ["ABEiM0RVZneImaq7zN3uAB", "AAAAAAAAAAAAAAAAAAAAAA"] {
        text.parse::<SessionToken>()
            .expect_err("invalid token bytes are refused");
    }
}

#[test]
fn are_drawn_distinct_from_crypto() {
    let mut drawn = std::collections::HashSet::new();
    for _ in 0..100 {
        let token =
            SessionToken::draw(|candidate| drawn.contains(candidate)).expect("a token from crypto");
        assert!(is_session_token(&token.to_string()));
        drawn.insert(token);
    }
    assert_eq!(drawn.len(), 100);
}

#[test]
fn holds_16_bytes_not_all_zero_and_refuses_any_other() {
    let bytes: [u8; 16] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
    let token = SessionToken::new(bytes).expect("16 bytes, not all zero");

    assert_eq!(token.bytes(), &bytes, "its bytes");
    assert_eq!(
        SessionToken::new([0; 16]).expect_err("all zero").message(),
        "a session token is 16 bytes, not all zero; got all zero",
        "all zero refused"
    );

    for length in [0, 15, 17] {
        assert_eq!(
            SessionToken::from_slice(&vec![1; length])
                .expect_err("another length")
                .message(),
            format!("a session token is 16 bytes, not all zero; got {length}"),
            "{length} bytes refused"
        );
    }

    assert_eq!(
        SessionToken::from_slice(&bytes).ok(),
        Some(token),
        "16 bytes read"
    );
}

#[test]
fn draws_a_token_none_holds_and_tells_one_from_another() {
    let held = SessionToken::new([7; 16]).expect("a token");
    let drawn = SessionToken::draw(|candidate| candidate.is(&held)).expect("a token drawn");

    assert!(!drawn.is(&held), "not the one in use");
    assert!(drawn.is(&drawn), "itself");
    assert!(drawn.bytes().iter().any(|byte| *byte != 0), "not all zero");
}

const TEXT: &str = "AAECAwQFBgcICQoLDA0ODw";
const BYTES: [u8; 16] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];

fn is_session_token(text: &str) -> bool {
    text.parse::<SessionToken>().is_ok()
}

#[test]
fn spells_its_16_bytes_in_unpadded_base64url_and_reads_them_back() {
    let token = SessionToken::new(BYTES).expect("a token");

    assert_eq!(token.to_string(), TEXT, "spelled");
    assert_eq!(TEXT.parse::<SessionToken>().ok(), Some(token), "read back");
    assert_eq!(token.bytes(), &BYTES, "its bytes");

    // the characters base64 has that base64url replaces
    let high = SessionToken::new([0xFB; 16]).expect("a token");

    assert_eq!(high.to_string(), "-_v7-_v7-_v7-_v7-_v7-w", "spelled");
    assert_eq!(
        "-_v7-_v7-_v7-_v7-_v7-w"
            .parse::<SessionToken>()
            .map(|read| *read.bytes())
            .ok(),
        Some([0xFB; 16]),
        "read back"
    );
}

#[test]
fn is_one_token_only_when_every_byte_is_one_byte_apart_at_either_end_is_another() {
    let token = SessionToken::new(BYTES).expect("a token");
    let apart = |index: usize| {
        let mut bytes = BYTES;

        if let Some(byte) = bytes.get_mut(index) {
            *byte ^= 0x01;
        }

        SessionToken::new(bytes).expect("a token")
    };

    assert!(
        token.is(&TEXT.parse().expect("a token")),
        "the same, read again"
    );
    assert!(!token.is(&apart(0)), "a byte apart at its start");
    assert!(!token.is(&apart(15)), "a byte apart at its end");
}

#[test]
fn refuses_bytes_of_another_length() {
    for length in [0, 15, 17] {
        assert!(
            SessionToken::from_slice(&vec![0; length]).is_err(),
            "{length} bytes refused"
        );
    }
}

#[test]
fn refuses_16_zero_bytes_which_are_no_token() {
    assert!(SessionToken::new([0; 16]).is_err(), "16 zero bytes refused");
    assert!(!is_session_token(&"A".repeat(22)), "nor spelled");
}

// a platform's shape: a &str is never null, so the null case has no counterpart
#[test]
fn refuses_text_that_spells_no_token() {
    for text in [
        "",
        "AAECAwQFBgcICQoLDA0OD",
        "AAECAwQFBgcICQoLDA0ODw==",
        "AAECAwQFBgcICQoLDA0ODx",
        "AAECAwQFBgcICQoLDA0O+w",
        "AAECAwQFBgcICQoLDA0O/w",
        "AAECAwQFBgcICQoLDA0O w",
    ] {
        assert!(!is_session_token(text), "{text:?} refused");
    }
}

#[test]
fn takes_as_its_last_character_each_one_that_spells_16_bytes_whole() {
    for last in ['A', 'Q', 'g', 'w'] {
        assert!(
            is_session_token(&format!("AAECAwQFBgcICQoLDA0OD{last}")),
            "{last} taken"
        );
    }
}

#[test]
fn throws_parsing_text_that_spells_no_token() {
    assert_eq!(
        "AAECAwQFBgcICQoLDA0ODx"
            .parse::<SessionToken>()
            .map_err(|refused| refused.to_string()),
        Err("\"AAECAwQFBgcICQoLDA0ODx\" is not a session token".to_owned()),
        "refused, naming it"
    );
}

// spec 15.1: a bearer's token, which no string a side writes carries; Display alone spells it, the
// application's way to read it (spec 13.2)
#[test]
fn writes_none_of_its_bytes_in_its_debug_nor_in_a_debug_that_holds_it() {
    let token = SessionToken::new(BYTES).expect("a token");

    assert_eq!(format!("{token:?}"), "SessionToken(…)", "its Debug");
    assert!(
        !format!("{:?}", Some(token)).contains(TEXT),
        "an application's Debug of an Option holds none of it"
    );
    assert!(
        !format!("{:#?}", [token]).contains(TEXT),
        "nor a pretty Debug of a list"
    );
    assert_eq!(token.to_string(), TEXT, "its Display spells it still");
}
