//! A session's token: 16 bytes, never all zero, drawn anew while one is in use, compared in
//! constant time.

use super::SessionToken;

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
