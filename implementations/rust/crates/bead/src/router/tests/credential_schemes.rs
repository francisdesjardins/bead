//! A refusal's credential schemes, ordered by number, unique and named as the other sides do.

use super::schemes_detail_of;

#[test]
fn names_a_scheme_to_come_by_the_word_scheme_and_its_number_in_the_order_of_the_numbers() {
    assert_eq!(
        schemes_detail_of(&[65_535, 3, 4, 1, 4].into_iter().collect()),
        "OPAQUE, ELSEWHERE, scheme 4, scheme 65535"
    );
    assert_eq!(schemes_detail_of(&std::collections::BTreeSet::new()), "");
}

#[test]
fn names_the_schemes_a_side_takes_in_the_order_of_their_numbers_a_comma_and_a_space_between() {
    for (schemes, expected) in [
        (vec![1], "OPAQUE"),
        (vec![3, 1, 2, 1], "OPAQUE, JWT, ELSEWHERE"),
        (vec![3, 1], "OPAQUE, ELSEWHERE"),
    ] {
        assert_eq!(schemes_detail_of(&schemes.into_iter().collect()), expected);
    }
}
