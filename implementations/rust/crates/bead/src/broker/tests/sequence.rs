//! One direction of a broker connection (spec 15.19, 15.20): its sequence, which hands each parcel
//! on once and in order, drops a copy and loses its connection at a gap; and its envelope in parts,
//! whole once its last part came, held to its bound, its participant's budget and its rate.

use core::sync::atomic::{AtomicUsize, Ordering};
use core::time::Duration;
use std::sync::Arc;
use std::time::SystemTime;

use bytes::Bytes;

use crate::broker::parcel::{Parcel, flags, kinds, write_parcel};
use crate::broker::sequence::{
    Budget, PartTaking, Parts, PartsBounds, Sequence, Taking, cut, fits,
};
use crate::clock::SharedClock;
use crate::testing::SteppingClock;

fn bounds_of((clock, budget): (&Arc<SteppingClock>, u64)) -> Arc<PartsBounds> {
    let clock: SharedClock = Arc::<SteppingClock>::clone(clock);

    Arc::new(PartsBounds {
        maximum_envelope_parts_bytes: 64,
        minimum_body_bytes_per_second: 240,
        body_grace_period: Duration::from_secs(5),
        budget: Arc::new(Budget::new(budget)),
        clock,
    })
}

fn part(bytes: &[u8]) -> Bytes {
    Bytes::copy_from_slice(bytes)
}

#[test]
fn hands_parcels_on_in_their_order_once_each_drops_a_copy_and_loses_the_connection_at_a_gap() {
    // an acceptor's direction, its OPEN 1 taken: the next awaited is 2
    let mut sequence = Sequence::new(2);

    assert_eq!(
        [1, 2, 2, 3, 4, 3].map(|each| sequence.take(each)),
        [
            Taking::Copy,
            Taking::Next,
            Taking::Copy,
            Taking::Next,
            Taking::Next,
            Taking::Copy
        ],
        "each in its order, once"
    );
    assert_eq!(sequence.awaited(), 5, "the next awaited");

    // * past the next one awaited: a loss, the window kept where it stood
    assert_eq!(sequence.take(7), Taking::Gap, "a gap");
    assert_eq!(sequence.awaited(), 5, "the window kept");
    assert_eq!(
        sequence.gap_of(7),
        "a parcel lost: 5 was awaited, and 7 came",
        "the gap named"
    );
}

#[tokio::test]
async fn reassembles_an_envelope_from_its_parts_and_loses_the_connection_past_its_bound_its_budget_or_its_rate()
 {
    let clock = SteppingClock::new(SystemTime::UNIX_EPOCH);
    let lates = Arc::new(AtomicUsize::new(0));
    let counting = Arc::clone(&lates);
    let bounds = bounds_of((&clock, 100));
    let mut parts = Parts::new(
        Arc::clone(&bounds),
        Arc::new(move || {
            counting.fetch_add(1, Ordering::SeqCst);
        }),
    );

    // whole at once, its credential beside it
    assert_eq!(
        parts.take((part(&[1, 2, 3]), false, Some("Bearer a".to_owned()))),
        PartTaking::Whole(part(&[1, 2, 3]), Some("Bearer a".to_owned())),
        "whole at once"
    );

    // in parts: held, then whole once its last came, the credential its first carried
    assert_eq!(
        parts.take((part(&[1, 2]), true, Some("Bearer b".to_owned()))),
        PartTaking::Held,
        "held"
    );
    assert_eq!(
        (parts.held_bytes(), bounds.budget.held()),
        (2, 2),
        "its part held and charged"
    );
    assert_eq!(
        parts.take((part(&[3]), false, None)),
        PartTaking::Whole(part(&[1, 2, 3]), Some("Bearer b".to_owned())),
        "whole once its last came"
    );
    assert_eq!(
        (parts.held_bytes(), bounds.budget.held()),
        (0, 0),
        "nothing held once whole"
    );

    // a credential on a part past the first does not read: 1002, naming it
    parts.take((part(&[1]), true, None));
    assert_eq!(
        parts.take((part(&[2]), false, Some("Bearer c".to_owned()))),
        PartTaking::Lost(
            1_002,
            "a part past the first of an envelope carries a credential".to_owned()
        ),
        "a credential past the first part"
    );
    assert_eq!(bounds.budget.held(), 0, "its budget given back");

    // past maximumEnvelopePartsBytes: 1009, naming the bound
    parts.take((part(&[0; 40]), true, None));
    assert_eq!(
        parts.take((part(&[0; 40]), true, None)),
        PartTaking::Lost(
            1_009,
            "an envelope's parts would pass maximumEnvelopePartsBytes, 64 bytes".to_owned()
        ),
        "past its bound"
    );
    parts.stop();

    // past the participant's budget, held across its connections: 4000, naming it
    let mut other = Parts::new(Arc::clone(&bounds), Arc::new(|| {}));

    other.take((part(&[0; 60]), true, None));
    parts.take((part(&[0; 10]), true, None));

    // * its last part charged as each before it
    assert_eq!(
        parts.take((part(&[0; 35]), false, None)),
        PartTaking::Lost(
            4_000,
            "a part would pass its participant's heldBytesBudget, 100 bytes".to_owned()
        ),
        "past its participant's budget"
    );
    assert_eq!(bounds.budget.held(), 60, "the other's parts held still");
    other.stop();

    // too slow once its grace passed, on the clock given: late at its deadline, not before
    parts.take((part(&[0; 10]), true, None));
    assert_eq!(clock.dues(), [Duration::from_secs(5)], "its grace armed");
    clock.advance(Duration::from_millis(4_999)).await;
    assert_eq!(
        (lates.load(Ordering::SeqCst), parts.is_late()),
        (0, false),
        "not late before its deadline"
    );
    clock.advance(Duration::from_millis(1)).await;
    assert_eq!(
        (lates.load(Ordering::SeqCst), parts.is_late()),
        (1, true),
        "late at its deadline"
    );
    assert_eq!(
        parts.late_of(),
        "an envelope's parts came slower than minimumBodyBytesPerSecond, 240 bytes a second, past bodyGracePeriod, 5000 ms",
        "its lateness named"
    );
    parts.stop();
    assert!(clock.dues().is_empty(), "its timer disarmed");
}

#[test]
fn cuts_an_envelope_in_parts_each_as_large_as_the_peer_s_bound_lets_it_the_credential_on_the_first_alone()
 {
    let envelope: Bytes = (0_u8..100).collect::<Vec<u8>>().into();
    let credential = Some("Bearer a".len());

    // whole where it fits
    let whole = cut(&envelope, (1_024, credential));

    assert_eq!(
        whole
            .iter()
            .map(|(part, carries)| (part.len(), *carries))
            .collect::<Vec<_>>(),
        [(100, true)],
        "whole, its credential beside it"
    );

    // in parts of the bound but the last: 28 bytes of prefix, 10 of credential on the first
    let parts = cut(&envelope, (68, credential));

    assert_eq!(
        parts
            .iter()
            .map(|(part, carries)| (part.len(), *carries))
            .collect::<Vec<_>>(),
        [(30, true), (40, false), (30, false)],
        "each as large as the bound lets it"
    );
    assert_eq!(
        parts
            .iter()
            .flat_map(|(part, _)| part.to_vec())
            .collect::<Vec<u8>>(),
        envelope.to_vec(),
        "the envelope whole across them"
    );

    for (index, (carried, carries)) in parts.iter().enumerate() {
        let written = write_parcel(&Parcel {
            flags: Some(if index < 2 { flags::MORE } else { 0 }),
            opener: 1,
            acceptor: 2,
            sequence: 3,
            credential: carries.then(|| "Bearer a".to_owned()),
            carried: Some(carried.clone()),
            ..Parcel::of(kinds::DATA)
        })
        .expect("written");

        assert!(written.len() <= 68, "a part within the bound");
    }

    // a bound that leaves no byte beside the credential cuts none
    assert!(cut(&envelope, (38, credential)).is_empty(), "none cut");
    assert!(!fits((38, credential)), "none fits");
    assert!(fits((29, None)), "a byte fits beside no credential");
}
