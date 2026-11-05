//! What a router's options give its limits: the intake limits a side keeps of its own (spec 15.12,
//! decision 0046), by the other sides' sentences.

use super::{INTAKE_DEFAULTS, IntakeLimits, IntakeLimitsOptions, intake_limits_of};

#[test]
fn gives_several_parts_as_one_and_refuses_a_count_two_of_them_name() {
    use super::Gauges;
    use std::collections::{BTreeMap, BTreeSet};
    use std::sync::Arc;

    let merged = Gauges::merge(vec![
        Gauges {
            ceilings: BTreeMap::from([("bytes", 8)]),
            ..Gauges::new(BTreeMap::from([("bytes", 1)]), [Arc::from("a")])
        },
        Gauges {
            anomalies: vec!["odd".to_owned()],
            ..Gauges::new(BTreeMap::from([("calls", 2)]), ["a", "b"].map(Arc::from))
        },
    ])
    .expect("each part names its own counts");

    assert_eq!(merged.counts, BTreeMap::from([("bytes", 1), ("calls", 2)]));
    assert_eq!(merged.ceilings, BTreeMap::from([("bytes", 8)]));
    assert_eq!(
        merged.connection_handles,
        BTreeSet::from(["a", "b"].map(Arc::from))
    );
    assert_eq!(merged.anomalies, ["odd"]);
    assert_eq!(Gauges::merge(vec![]).expect("no parts"), Gauges::default());

    let refused = Gauges::merge(vec![
        Gauges::new(BTreeMap::from([("calls", 1)]), []),
        Gauges::new(BTreeMap::from([("calls", 2)]), []),
    ])
    .expect_err("two parts name calls");
    assert_eq!(refused.message(), "two parts count calls");
}

#[test]
fn gives_a_part_s_gauges_what_it_does_not_give_being_none() {
    use super::Gauges;
    use std::collections::{BTreeMap, BTreeSet};
    use std::sync::Arc;

    let gauges = Gauges::new(BTreeMap::from([("calls", 2)]), []);
    assert_eq!(gauges.counts, BTreeMap::from([("calls", 2)]));
    assert_eq!(gauges.anomalies, Vec::<String>::new());
    assert!(gauges.ceilings.is_empty());
    assert!(gauges.connection_handles.is_empty());

    let populated = Gauges {
        ceilings: BTreeMap::from([("calls", 4)]),
        anomalies: vec!["odd".to_owned()],
        ..Gauges::new(
            BTreeMap::from([("calls", 3)]),
            ["a", "a", "b"].map(Arc::from),
        )
    };
    assert_eq!(populated.counts, BTreeMap::from([("calls", 3)]));
    assert_eq!(populated.ceilings, BTreeMap::from([("calls", 4)]));
    assert_eq!(
        populated.connection_handles,
        BTreeSet::from([Arc::from("a"), Arc::from("b")])
    );
    assert_eq!(populated.anomalies, ["odd"]);
    assert_eq!(
        Gauges::new(BTreeMap::new(), ["a", "a", "b"].map(Arc::from)).connection_handles,
        populated.connection_handles
    );
    assert!(Gauges::new(BTreeMap::new(), []).counts.is_empty());

    // A reader borrows its snapshot; no part can be changed through that borrow.
    let consumer = crate::testing::surface::Consumer::new();
    for mutation in [
        "gauges.counts.insert(\"calls\", 9);",
        "gauges.ceilings.insert(\"calls\", 9);",
        "gauges.anomalies.push(String::new());",
        "gauges.connection_handles.clear();",
    ] {
        consumer.refuses(
            &format!("pub fn check(gauges: &bead::Gauges) {{ {mutation} }}"),
            ("E0596", "cannot borrow"),
        );
    }
}

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
