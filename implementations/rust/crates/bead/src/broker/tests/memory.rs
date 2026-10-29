//! The core's in-memory broker (spec 15.24): every capability, each message handed on once, later,
//! in its publisher's order; and, as a test asks, copied, held, dropped, handed to another member,
//! its queues bounded and its links lost.

use core::time::Duration;
use std::sync::{Arc, Mutex};
use std::time::SystemTime;

use bytes::Bytes;
use tokio_util::sync::CancellationToken;

use super::locked;
use crate::broker::adapter::{
    BrokerAdapter, BrokerCapabilities, BrokerDown, BrokerError, BrokerListener, BrokerMessage,
    BrokerPublication, BrokerPublished, BrokerStart, BrokerSubscription,
};
use crate::broker::memory::{
    MemoryBroker, MemoryBrokerAdapter, MemoryBrokerAdapterOptions, MemoryBrokerFault,
    MemoryBrokerFaultOptions, MemoryBrokerOptions,
};
use crate::clock::SharedClock;
use crate::testing::SteppingClock;

const TOPIC: [&str; 3] = ["bead", "s", "interop"];

fn topic() -> Vec<String> {
    TOPIC.iter().map(|token| (*token).to_owned()).collect()
}

fn topic_of(tokens: [&str; 3]) -> Vec<String> {
    tokens.iter().map(|token| (*token).to_owned()).collect()
}

// a broker on a stepping clock, whose turns it settles on
fn broker_on(options: MemoryBrokerOptions) -> (MemoryBroker, Arc<SteppingClock>) {
    let clock = SteppingClock::new(SystemTime::UNIX_EPOCH);
    let shared: SharedClock = Arc::<SteppingClock>::clone(&clock);
    let mut options = options;

    options.clock = Some(shared);

    (MemoryBroker::new(&options).expect("a broker"), clock)
}

type Heard = Arc<Mutex<Vec<String>>>;

// what an adapter hears, its acknowledgement given as it comes; and each down
struct Hearing {
    heard: Heard,
    downs: Arc<Mutex<Vec<bool>>>,
}

impl BrokerListener for Hearing {
    fn on_message(&self, message: &BrokerMessage) {
        let hexadecimal = crate::testing::hexadecimal::text_of(message.payload()).replace(' ', "");

        locked(&self.heard).push(format!(
            "{}{hexadecimal}",
            if message.is_retained() {
                "retained "
            } else {
                ""
            }
        ));
        message.settle();
    }

    fn on_down(&self, down: BrokerDown) {
        locked(&self.downs).push(down.is_taken_over);
    }
}

// an adapter of the broker, what reached it and its downs
fn heard_by(adapter: &MemoryBrokerAdapter) -> (Heard, Arc<Mutex<Vec<bool>>>) {
    let heard: Heard = Arc::default();
    let downs: Arc<Mutex<Vec<bool>>> = Arc::default();

    adapter.listen(Arc::new(Hearing {
        heard: Arc::clone(&heard),
        downs: Arc::clone(&downs),
    }));

    (heard, downs)
}

// a linked adapter of the broker and what reached it, its acknowledgement given as it comes
async fn linked_of((broker, id): (&MemoryBroker, &str)) -> (MemoryBrokerAdapter, Heard) {
    let adapter = broker
        .adapter(&MemoryBrokerAdapterOptions::of(id))
        .expect("an adapter");
    let (heard, _) = heard_by(&adapter);

    adapter
        .start(BrokerStart::default())
        .await
        .expect("started");

    (adapter, heard)
}

fn publication_of(payload: u8) -> BrokerPublication {
    BrokerPublication::of(TOPIC, Bytes::from(vec![payload]))
}

fn taken(heard: &Heard) -> Vec<String> {
    core::mem::take(&mut *locked(heard))
}

// spec 15.24
#[tokio::test]
async fn hands_each_message_on_once_in_a_later_turn_in_the_order_its_publisher_published_to_that_topic()
 {
    let (broker, clock) = broker_on(MemoryBrokerOptions::default());
    let (publisher, _) = linked_of((&broker, "ada")).await;
    let (subscriber, heard) = linked_of((&broker, "bob")).await;

    subscriber
        .subscribe(&topic(), BrokerSubscription::default())
        .await
        .expect("subscribed");

    // * each published as it is called, none awaited before the next; never within the turn it
    // was published in
    let publishing = [1, 2, 3].map(|payload| publisher.publish(publication_of(payload)));

    assert!(locked(&heard).is_empty(), "nothing within the publish");

    for each in publishing {
        assert_eq!(
            each.await.expect("published"),
            BrokerPublished::Taken,
            "taken"
        );
    }

    clock.settle().await;
    assert_eq!(taken(&heard), ["01", "02", "03"], "each once, in order");
    assert_eq!(subscriber.unsettled(), 0, "each acknowledged");

    // what no subscription takes is refused so, and a topic is matched whole
    let mut other = publication_of(4);

    other.topic = topic_of(["bead", "s", "other"]);
    assert_eq!(
        publisher.publish(other).await.expect("published"),
        BrokerPublished::NoSubscriber,
        "no subscriber"
    );
    assert_eq!(
        publisher
            .publish(publication_of(5))
            .await
            .expect("published"),
        BrokerPublished::Taken,
        "taken"
    );
    clock.settle().await;
    assert_eq!(taken(&heard), ["05"], "the one taken");
}

// spec 15.24
#[tokio::test]
async fn hands_a_group_message_to_one_member_in_turn_and_again_to_another_when_a_test_asks() {
    let (broker, clock) = broker_on(MemoryBrokerOptions::default());
    let (publisher, _) = linked_of((&broker, "ada")).await;
    let (first, first_heard) = linked_of((&broker, "bob")).await;
    let (second, second_heard) = linked_of((&broker, "cid")).await;
    let (alone, alone_heard) = linked_of((&broker, "dee")).await;
    let group = BrokerSubscription {
        group: Some("interop".to_owned()),
        ..BrokerSubscription::default()
    };

    first
        .subscribe(&topic(), group.clone())
        .await
        .expect("subscribed");
    second
        .subscribe(&topic(), group.clone())
        .await
        .expect("subscribed");
    alone
        .subscribe(&topic(), BrokerSubscription::default())
        .await
        .expect("subscribed");

    for payload in [1, 2, 3, 4] {
        publisher
            .publish(publication_of(payload))
            .await
            .expect("published");
    }

    clock.settle().await;

    // * one member in turn; one held alone takes every one
    assert_eq!(*locked(&first_heard), ["01", "03"], "the first member's");
    assert_eq!(*locked(&second_heard), ["02", "04"], "the second member's");
    assert_eq!(*locked(&alone_heard), ["01", "02", "03", "04"], "every one");

    // again to another member, as a broker whose member's session ended unacknowledged does
    broker.fault(
        MemoryBrokerFault::Redeliver,
        &MemoryBrokerFaultOptions {
            topic: Some(topic()),
        },
    );
    publisher
        .publish(publication_of(5))
        .await
        .expect("published");
    clock.settle().await;
    assert_eq!(
        *locked(&first_heard),
        ["01", "03", "05"],
        "the first member's"
    );
    assert_eq!(
        *locked(&second_heard),
        ["02", "04", "05"],
        "the second member's"
    );
    assert_eq!(
        *locked(&alone_heard),
        ["01", "02", "03", "04", "05"],
        "every one"
    );

    // a group needs its adapter to offer one
    let mut options = MemoryBrokerAdapterOptions::of("plain");

    options.capabilities = Some(BrokerCapabilities::NONE);

    let plain = broker.adapter(&options).expect("an adapter");

    plain.start(BrokerStart::default()).await.expect("started");
    assert!(
        matches!(
            plain.subscribe(&topic(), group).await,
            Err(BrokerError::Refused(refused)) if refused.message() == "the adapter of plain offers no groups"
        ),
        "a group refused"
    );
}

// spec 15.24
#[tokio::test]
async fn copies_reorders_and_drops_a_message_as_a_test_asks_drops_past_a_subscriber_s_queue_bound_and_publishes_a_will_as_a_link_is_lost()
 {
    let (broker, clock) = broker_on(MemoryBrokerOptions {
        maximum_queued_messages: Some(2),
        ..MemoryBrokerOptions::default()
    });
    let (publisher, _) = linked_of((&broker, "ada")).await;
    let (subscriber, heard) = linked_of((&broker, "bob")).await;

    subscriber
        .subscribe(&topic(), BrokerSubscription::default())
        .await
        .expect("subscribed");

    // copied, held behind the next, dropped: each fault befalls one message, in turn
    for fault in [
        MemoryBrokerFault::Copy,
        MemoryBrokerFault::Hold,
        MemoryBrokerFault::Drop,
    ] {
        broker.fault(fault, &MemoryBrokerFaultOptions::default());
    }

    for payload in [1, 2, 3, 4, 5] {
        let mut publication = publication_of(payload);

        publication.expires_after = Some(Duration::from_secs(60));
        publisher.publish(publication).await.expect("published");
        clock.settle().await;
    }

    assert_eq!(
        taken(&heard),
        ["01", "01", "04", "02", "05"],
        "copied, held behind the next, dropped"
    );

    // past a subscriber's queue bound, the one published is dropped
    let publishing = [6, 7, 8].map(|payload| publisher.publish(publication_of(payload)));

    for each in publishing {
        each.await.expect("published");
    }

    clock.settle().await;
    assert_eq!(taken(&heard), ["06", "07"], "the third dropped");

    // retained, as a test asks; and a message whose life passed before it was handed on, deleted
    publisher
        .publish_retained(publication_of(9))
        .await
        .expect("published");

    let mut short = publication_of(10);

    short.expires_after = Some(Duration::from_secs(1));

    let expiring = publisher.publish(short);

    clock.wall_by(2_000);
    expiring.await.expect("published");
    clock.settle().await;
    assert_eq!(
        taken(&heard),
        ["retained 09"],
        "retained, and the expired deleted"
    );

    // a will, published as a link is lost, never at a stop; its loss told
    let departure = topic_of(["bead", "d", "cid"]);
    let (lost, _) = linked_of((&broker, "cid-link")).await;
    let will = BrokerStart {
        will: Some(BrokerPublication::of(
            departure.clone(),
            Bytes::from_static(&[0x0A]),
        )),
        ..BrokerStart::default()
    };
    let leaving = broker
        .adapter(&MemoryBrokerAdapterOptions::of("cid"))
        .expect("an adapter");
    let (_, downs) = heard_by(&leaving);

    subscriber
        .subscribe(&departure, BrokerSubscription::default())
        .await
        .expect("subscribed");
    leaving.start(will.clone()).await.expect("started");
    leaving.stop().await;
    clock.settle().await;
    assert!(locked(&heard).is_empty(), "no will at a stop");

    leaving.start(will).await.expect("started");
    leaving.lose();
    clock.settle().await;
    assert_eq!(taken(&heard), ["0A"], "its will at its loss");
    assert_eq!(
        (locked(&downs).len(), leaving.is_linked()),
        (1, false),
        "its loss told"
    );
    assert!(lost.is_linked(), "another link kept");
}

// spec 15.24
#[tokio::test]
async fn takes_a_link_over_as_a_test_asks_as_a_second_link_of_its_id_would_its_subscriptions_dropped_its_will_published_its_down_told_taken_over()
 {
    let (broker, clock) = broker_on(MemoryBrokerOptions::default());
    let (ada, heard) = linked_of((&broker, "ada")).await;
    let bob = broker
        .adapter(&MemoryBrokerAdapterOptions::of("bob"))
        .expect("an adapter");
    let departure = topic_of(["bead", "d", "bob"]);
    let inbox = topic_of(["bead", "i", "bob"]);
    let (_, downs) = heard_by(&bob);

    ada.subscribe(&departure, BrokerSubscription::default())
        .await
        .expect("subscribed");
    bob.start(BrokerStart {
        will: Some(BrokerPublication::of(
            departure.clone(),
            Bytes::from_static(&[0x0A]),
        )),
        ..BrokerStart::default()
    })
    .await
    .expect("started");
    bob.subscribe(&inbox, BrokerSubscription::default())
        .await
        .expect("subscribed");
    bob.take_over();
    clock.settle().await;

    assert!(!bob.is_linked(), "taken over");
    assert_eq!(*locked(&downs), [true], "its down told taken over");
    assert_eq!(taken(&heard), ["0A"], "its will published");

    // * no link of its id holds its inbox now
    assert_eq!(
        ada.publish(BrokerPublication::of(inbox, Bytes::from_static(&[1])))
            .await
            .expect("published"),
        BrokerPublished::NoSubscriber,
        "no subscriber"
    );

    // a loss tells its down otherwise, and a takeover of a link not up does nothing
    bob.start(BrokerStart::default()).await.expect("started");
    bob.lose();
    bob.take_over();
    clock.settle().await;
    assert_eq!(*locked(&downs), [true, false], "a loss told");
}

#[tokio::test]
async fn refuses_a_second_adapter_of_one_id_and_a_will_asked_of_an_adapter_that_takes_none() {
    let (broker, _clock) = broker_on(MemoryBrokerOptions::default());
    let mut options = MemoryBrokerAdapterOptions::of("ada");

    options.capabilities = Some(BrokerCapabilities::NONE);

    let plain = broker.adapter(&options).expect("an adapter");

    assert_eq!(
        broker
            .adapter(&MemoryBrokerAdapterOptions::of("ada"))
            .expect_err("refused")
            .message(),
        "an adapter of this broker is ada already",
        "a second adapter of one id"
    );
    assert!(
        matches!(
            plain
                .start(BrokerStart {
                    will: Some(BrokerPublication::of(
                        ["bead", "d", "ada"],
                        Bytes::from_static(b"gone"),
                    )),
                    ..BrokerStart::default()
                })
                .await,
            Err(BrokerError::Refused(refused)) if refused.message() == "the adapter of ada takes no will"
        ),
        "a will refused"
    );
    assert!(!plain.is_linked(), "not linked");
}

#[tokio::test]
async fn refuses_a_publication_given_up_on_before_it_goes() {
    let (broker, clock) = broker_on(MemoryBrokerOptions::default());
    let (publisher, _) = linked_of((&broker, "ada")).await;
    let (subscriber, heard) = linked_of((&broker, "bob")).await;
    let given_up = CancellationToken::new();
    let mut publication = publication_of(1);

    given_up.cancel();
    publication.signal = Some(given_up);
    subscriber
        .subscribe(&topic(), BrokerSubscription::default())
        .await
        .expect("subscribed");
    assert_eq!(
        publisher
            .publish(publication)
            .await
            .expect_err("refused")
            .to_string(),
        "the publication was given up on",
        "given up on"
    );
    clock.settle().await;
    assert!(locked(&heard).is_empty(), "nothing handed on");
}

#[tokio::test]
async fn refuses_a_start_of_a_link_up_already_and_a_publication_past_maximum_message_bytes_or_of_a_link_not_up_drops_what_a_link_lost_held_and_a_loss_of_a_link_not_up_does_nothing()
 {
    let (broker, clock) = broker_on(MemoryBrokerOptions {
        maximum_message_bytes: Some(4),
        ..MemoryBrokerOptions::default()
    });
    let ada = broker
        .adapter(&MemoryBrokerAdapterOptions::of("ada"))
        .expect("an adapter");
    let (heard, downs) = heard_by(&ada);
    let inbox = topic_of(["bead", "i", "ada"]);

    // a link never up is lost of nothing: no down told
    ada.lose();
    clock.settle().await;
    assert!(locked(&downs).is_empty(), "no down");

    ada.start(BrokerStart::default()).await.expect("started");
    ada.subscribe(&inbox, BrokerSubscription::default())
        .await
        .expect("subscribed");

    let (bob, _) = linked_of((&broker, "bob")).await;

    assert_eq!(
        ada.start(BrokerStart::default())
            .await
            .expect_err("refused")
            .to_string(),
        "the link of ada is up already",
        "up already"
    );
    assert_eq!(
        bob.publish(BrokerPublication::of(
            inbox.clone(),
            Bytes::from_static(b"fives")
        ))
        .await
        .expect_err("refused")
        .to_string(),
        "a payload of 5 bytes, past the broker's maximumMessageBytes, 4 bytes",
        "past its bound"
    );

    // * published, then its subscriber's link lost in the same turn: what it held goes with it
    let published = bob.publish(BrokerPublication::of(
        inbox.clone(),
        Bytes::from_static(b"lost"),
    ));

    ada.lose();
    clock.settle().await;
    assert_eq!(
        (
            published.await.expect("published"),
            locked(&heard).len(),
            locked(&downs).len()
        ),
        (BrokerPublished::Taken, 0, 1),
        "what it held goes with it"
    );
    assert_eq!(
        ada.publish(publication_of(1))
            .await
            .expect_err("refused")
            .to_string(),
        "the link of ada is not up",
        "not up"
    );

    // an adapter no listener hears: handed a message, then lost, telling no one
    let cid = broker
        .adapter(&MemoryBrokerAdapterOptions::of("cid"))
        .expect("an adapter");
    let cid_inbox = topic_of(["bead", "i", "cid"]);

    cid.start(BrokerStart::default()).await.expect("started");
    cid.subscribe(&cid_inbox, BrokerSubscription::default())
        .await
        .expect("subscribed");
    bob.publish(BrokerPublication::of(cid_inbox, Bytes::from_static(&[1])))
        .await
        .expect("published");
    clock.settle().await;
    cid.lose();
    clock.settle().await;
    assert!(!cid.is_linked(), "lost");
}
