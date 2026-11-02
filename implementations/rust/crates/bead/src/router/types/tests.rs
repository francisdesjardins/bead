//! What a router's options give its limits: the intake limits a side keeps of its own (spec 15.12,
//! decision 0046), by the other sides' sentences.

use super::{INTAKE_DEFAULTS, IntakeLimits, IntakeLimitsOptions, intake_limits_of};

// spec 15.12.17, 15.12.18: the twin of "the intake limits refuse a bound below 1, and default to 64
// and 1 MiB"
#[test]
fn the_intake_limits_refuse_a_bound_below_1_and_default_to_64_and_1_mib() {
    assert_eq!(
        intake_limits_of(&IntakeLimitsOptions::default()).expect("the defaults"),
        IntakeLimits {
            maximum_untaken_envelopes: 64,
            maximum_untaken_bytes: 1_048_576,
        },
        "64 envelopes and 1 MiB, when its options say nothing"
    );
    assert_eq!(
        intake_limits_of(&IntakeLimitsOptions::default()).expect("the defaults"),
        INTAKE_DEFAULTS,
        "its defaults"
    );
    assert_eq!(
        intake_limits_of(&IntakeLimitsOptions {
            maximum_untaken_envelopes: Some(1),
            maximum_untaken_bytes: Some(1),
        })
        .expect("a bound of 1 each"),
        IntakeLimits {
            maximum_untaken_envelopes: 1,
            maximum_untaken_bytes: 1,
        },
        "a bound of 1 holds"
    );

    for (options, said) in [
        (
            IntakeLimitsOptions {
                maximum_untaken_envelopes: Some(0),
                ..IntakeLimitsOptions::default()
            },
            "maximumUntakenEnvelopes is a whole number above 0, not 0",
        ),
        (
            IntakeLimitsOptions {
                maximum_untaken_bytes: Some(0),
                ..IntakeLimitsOptions::default()
            },
            "maximumUntakenBytes is a whole number above 0, not 0",
        ),
    ] {
        let refused = intake_limits_of(&options).expect_err("a bound below 1 refused");

        assert_eq!(refused.to_string(), said, "said why");
    }
}
