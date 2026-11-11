//! The send quota on its own (spec 15.28): what no link reaches through the adapter, which refuses
//! what is asked of a link ended or under a signal cancelled already before its quota hears of it —
//! a cancel that comes once a publication went, an end told twice. The C# side's
//! `MqttSendQuotaTests` play the same sentences; the TypeScript side keeps its quota inside its
//! adapter, whose tests play the rest of it, as the adapter's tests here do.

use tokio_util::sync::CancellationToken;

use super::{Queued, SendQuota};

#[test]
fn sends_at_once_within_its_room_holds_the_rest_in_their_order_and_keeps_one_sent_as_it_freed_whatever_its_token_says_after()
 {
    let mut quota = SendQuota::new(1);
    let leaving = CancellationToken::new();
    let first = quota.enqueue((1, 1), None);
    let second = quota.enqueue((2, 2), Some(&leaving));

    assert!(matches!(first, Queued::Send(1)), "the first sent at once");
    assert!(matches!(second, Queued::Waiting), "the second waits");
    assert_eq!((quota.in_flight(), quota.queued()), (1, 1), "one each");

    // * sent as a PUBACK freed its room: a cancel after it takes nothing back
    assert_eq!(quota.release(), vec![2], "the second freed");
    leaving.cancel();
    assert_eq!(quota.leave(2), None, "gone already");
    assert_eq!(
        (quota.in_flight(), quota.queued()),
        (1, 0),
        "sent, none waiting"
    );
}

#[test]
fn fails_at_once_what_is_asked_once_it_ended_or_under_a_token_cancelled_already_sending_nothing_and_ends_once()
 {
    let mut quota = SendQuota::new(1);
    let cancelled = CancellationToken::new();

    cancelled.cancel();

    assert!(
        matches!(quota.enqueue((1, 1), Some(&cancelled)), Queued::GivenUp(1)),
        "given up already, nothing sent"
    );
    assert!(
        matches!(quota.enqueue((2, 2), None), Queued::Send(2)),
        "sent"
    );
    assert!(
        matches!(quota.enqueue((3, 3), None), Queued::Waiting),
        "waits"
    );
    assert_eq!(quota.end(), vec![3], "what waits handed back to be failed");
    assert_eq!(quota.end(), Vec::<i32>::new(), "an end told once");
    assert!(
        matches!(quota.enqueue((4, 4), None), Queued::Ended(4)),
        "none taken once it ended"
    );

    // nothing goes once it ended, whatever frees its room
    assert_eq!(quota.release(), Vec::<i32>::new(), "nothing freed");
    assert_eq!(quota.queued(), 0, "nothing queued");
    assert!(quota.is_drained(), "drained once ended");
}
