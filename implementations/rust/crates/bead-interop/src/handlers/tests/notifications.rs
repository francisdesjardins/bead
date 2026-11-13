//! The client's notification twins use the interop ticks and tick over a binary memory link.

use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use bead::internal::{Envelope, write_envelope};
use bead::testing::pair::{Pair, PairOptions};
use bead::{
    DebugDirection, EnvelopeHeader, Failure, JsonCodec, Notification, NotificationCallback,
    NotificationDependencies, NotificationHeader, PacingLimitsOptions, ProtocolCode,
    RegistrationOptions, RequestDependencies, RequestOptions, Sent, ServerOptions, ServerTransport,
    TransportMessage,
};
use serde_json::{Value, json};
use tokio::sync::oneshot;

use crate::{InteropProcedures, OfferedInterop, offer_interop};

type News = Notification<JsonCodec, JsonCodec, JsonCodec>;

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

struct Fixture {
    pair: Pair,
    procedures: &'static InteropProcedures,
    _offered: OfferedInterop,
    sent: Arc<Mutex<Vec<EnvelopeHeader>>>,
}

impl Fixture {
    async fn new() -> Self {
        let mut server = ServerOptions::default();
        let mut pacing = PacingLimitsOptions::default();
        pacing.maximum_queued_notifications = Some(2);
        server.pacing = Some(pacing);
        let mut options = PairOptions::default();
        options.server = Some(server);
        let pair = Pair::connected(bead::testing::instants::new_year(), &options)
            .await
            .expect("a binary link");
        let offered = offer_interop(&pair.server).expect("the interop offered");
        let sent = Arc::new(Mutex::new(Vec::new()));
        let sending = Arc::clone(&sent);
        pair.client
            .router()
            .on_debug(Arc::new(move |direction, envelope| {
                if direction == DebugDirection::Tx {
                    locked(&sending).push(envelope.header.clone());
                }
            }));
        Self {
            pair,
            procedures: InteropProcedures::get().expect("the descriptors"),
            _offered: offered,
            sent,
        }
    }

    fn ticks(&self, window: Option<u64>) -> News {
        let mut dependencies = NotificationDependencies::new(
            RequestDependencies::new(JsonCodec, JsonCodec),
            JsonCodec,
        );
        dependencies.window = window;
        self.pair
            .client
            .services()
            .get_notification(self.procedures.ticks.descriptor().procedure(), dependencies)
            .expect("ticks declared")
    }

    async fn tick(&self, value: i64) {
        self.pair
            .client
            .services()
            .get_request(
                self.procedures.tick.procedure(),
                RequestDependencies::new(JsonCodec, JsonCodec),
            )
            .expect("tick declared")
            .call(json!({"value": value}), &RequestOptions::default())
            .expect("tick starts")
            .await
            .expect("tick answered");
        self.pair.settle().await;
    }

    fn subscriptions(&self) -> Vec<bead::RequestHeader> {
        locked(&self.sent)
            .iter()
            .filter_map(|header| {
                if let EnvelopeHeader::Request(header) = header {
                    return header.opens_subscription.then(|| header.clone());
                }
                None
            })
            .collect()
    }

    async fn dispose(self) {
        self.pair.client.dispose().await;
        self.pair
            .server
            .dispose()
            .await
            .expect("the server disposed");
    }
}

fn callback(heard: &Arc<Mutex<Vec<i64>>>) -> NotificationCallback<Value> {
    let heard = Arc::clone(heard);
    Arc::new(move |value| {
        locked(&heard).push(value.as_i64().expect("an integer notification"));
        Box::pin(async { Ok(()) })
    })
}

fn held_callback(
    heard: &Arc<Mutex<Vec<i64>>>,
) -> (NotificationCallback<Value>, oneshot::Sender<()>) {
    let (release, waiting) = oneshot::channel();
    let waiting = Arc::new(Mutex::new(Some(waiting)));
    let heard = Arc::clone(heard);
    let callback: NotificationCallback<Value> = Arc::new(move |value| {
        locked(&heard).push(value.as_i64().expect("an integer notification"));
        let waiting = locked(&waiting).take();
        Box::pin(async move {
            if let Some(waiting) = waiting {
                waiting.await.expect("the callback released");
            }
            Ok(())
        })
    });
    (callback, release)
}

#[tokio::test]
async fn a_callback_registered_hears_each_notification_and_two_share_one_request() {
    let fixture = Fixture::new().await;
    let ticks = fixture.ticks(None);
    let heard = Arc::new(Mutex::new(Vec::new()));
    let also = Arc::new(Mutex::new(Vec::new()));
    let first = ticks
        .register(
            Value::Null,
            callback(&heard),
            &RegistrationOptions::default(),
        )
        .await
        .expect("the first registered");
    let second = ticks
        .register(
            Value::Null,
            callback(&also),
            &RegistrationOptions::default(),
        )
        .await
        .expect("the second registered");
    fixture.tick(1).await;
    fixture.tick(2).await;
    assert_eq!(*locked(&heard), [1, 2]);
    assert_eq!(*locked(&also), [1, 2]);
    assert_eq!(fixture.subscriptions().len(), 1);
    first.unregister().await.expect("the first removed");
    second.unregister().await.expect("the last removed");
    fixture.dispose().await;
}

#[tokio::test]
async fn a_paced_subscription_credits_the_next_once_the_callback_settled() {
    let fixture = Fixture::new().await;
    let ticks = fixture.ticks(Some(1));
    let heard = Arc::new(Mutex::new(Vec::new()));
    let (holding, release) = held_callback(&heard);
    let registration = ticks
        .register(Value::Null, holding, &RegistrationOptions::default())
        .await
        .expect("registered");
    assert_eq!(fixture.subscriptions().len(), 1);
    assert!(fixture.subscriptions()[0].paced);
    fixture.tick(1).await;
    fixture.tick(2).await;
    assert_eq!(*locked(&heard), [1]);
    assert!(
        !locked(&fixture.sent)
            .iter()
            .any(|header| matches!(header, EnvelopeHeader::Credit(_)))
    );
    release.send(()).expect("the first callback released");
    fixture.pair.settle().await;
    assert_eq!(*locked(&heard), [1, 2]);
    assert!(locked(&fixture.sent).iter().any(|header| matches!(header,
        EnvelopeHeader::Credit(header) if header.paced && header.credit_end == 2)));
    registration.unregister().await.expect("removed");
    fixture.dispose().await;
}

#[tokio::test]
async fn the_last_registration_taken_away_cancels_the_subscription_and_a_late_notification_is_dropped_in_silence()
 {
    let fixture = Fixture::new().await;
    let ticks = fixture.ticks(None);
    let heard = Arc::new(Mutex::new(Vec::new()));
    let registration = ticks
        .register(
            Value::Null,
            callback(&heard),
            &RegistrationOptions::default(),
        )
        .await
        .expect("registered");
    let call_id = fixture.subscriptions()[0].call_id;
    registration.unregister().await.expect("removed");
    fixture.pair.settle().await;
    assert!(locked(&fixture.sent).iter().any(|header| matches!(header,
        EnvelopeHeader::Cancel(header) if header.call_id == call_id)));
    let bytes = write_envelope(
        &Envelope::Notification {
            header: NotificationHeader { call_id },
            payload: b"9".as_slice().into(),
        },
        1_024,
    )
    .expect("the late notification encoded");
    let mut message = TransportMessage::default();
    message.data = bytes;
    if let Sent::Later(sent) = fixture
        .pair
        .memory
        .send(message, &fixture.pair.connection_handle)
        .expect("the late bytes handed over")
    {
        sent.await.expect("the late bytes sent");
    }
    fixture.tick(1).await;
    assert_eq!(*locked(&heard), Vec::<i64>::new());
    assert_eq!(locked(&fixture.pair.client_reports).len(), 0);
    fixture.dispose().await;
}

#[tokio::test]
async fn a_trigger_never_registered_is_an_invalid_operation_a_payload_that_does_not_decode_a_failure_reported()
 {
    use std::error::Error;

    let fixture = Fixture::new().await;
    let ticks = fixture.ticks(None);
    let heard = Arc::new(Mutex::new(Vec::new()));
    let early = ticks.as_like().trigger(b"1".as_slice().into());
    assert!(matches!(early, Err(bead::RouterError::Other(error)) if
        error.downcast_ref::<bead::ProgrammerError>().is_some()));
    let failures = Arc::new(Mutex::new(Vec::new()));
    let hearing = Arc::clone(&failures);
    fixture
        .pair
        .client
        .router()
        .on_error(Arc::new(move |error| {
            locked(&hearing).push(error.clone());
        }));
    let registration = ticks
        .register(
            Value::Null,
            callback(&heard),
            &RegistrationOptions::default(),
        )
        .await
        .expect("registered");
    let call_id = fixture.subscriptions()[0].call_id;
    let bytes = write_envelope(
        &Envelope::Notification {
            header: NotificationHeader { call_id },
            payload: b"{not json".as_slice().into(),
        },
        1_024,
    )
    .expect("the notification encoded");
    let mut message = TransportMessage::default();
    message.data = bytes;
    if let Sent::Later(sent) = fixture
        .pair
        .memory
        .send(message, &fixture.pair.connection_handle)
        .expect("the notification handed over")
    {
        sent.await.expect("the notification sent");
    }
    fixture.pair.settle().await;

    let errors = locked(&failures).clone();
    let [bead::RouterError::Failure(failure)] = errors.as_slice() else {
        panic!("one notification read failure is reported");
    };
    assert_eq!(failure.code(), ProtocolCode::PAYLOAD_UNDECODABLE.get());
    assert_eq!(failure.origin(), bead::FailureOrigin::Local);
    assert_eq!(failure.side(), Some(bead::RouterSide::Client));
    assert_eq!(
        failure.procedure(),
        Some(fixture.procedures.ticks.descriptor().procedure().address())
    );
    assert!(failure.header().is_none());
    assert!(failure.source().is_some());
    assert_eq!(*locked(&heard), Vec::<i64>::new());
    registration.unregister().await.expect("removed");
    fixture.dispose().await;
}

#[tokio::test]
async fn a_subscription_the_server_ends_is_dropped_and_told_with_its_failure() {
    let fixture = Fixture::new().await;
    let ticks = fixture.ticks(Some(1));
    let dropped = Arc::new(Mutex::new(Vec::new()));
    let hearing = Arc::clone(&dropped);
    fixture
        .pair
        .client
        .services()
        .on_dropped(Arc::new(move |_, failure| {
            locked(&hearing).push(failure.map(Failure::record));
        }));
    let (holding, release) = held_callback(&Arc::new(Mutex::new(Vec::new())));
    let registration = ticks
        .register(Value::Null, holding, &RegistrationOptions::default())
        .await
        .expect("registered");
    for value in 1..=4 {
        fixture.tick(value).await;
    }
    assert_eq!(locked(&dropped).len(), 1);
    assert_eq!(
        locked(&dropped)[0]
            .as_ref()
            .expect("the drop's failure")
            .code,
        ProtocolCode::CAPACITY_EXCEEDED.get()
    );
    assert!(
        !fixture
            .pair
            .client
            .router()
            .has_notification(&ticks.as_like())
    );
    release.send(()).expect("the callback released");
    fixture.pair.settle().await;
    assert_eq!(locked(&fixture.pair.client_reports).len(), 0);
    let again = ticks
        .register(
            Value::Null,
            callback(&Arc::new(Mutex::new(Vec::new()))),
            &RegistrationOptions::default(),
        )
        .await
        .expect("subscribed again");
    assert_eq!(fixture.subscriptions().len(), 2);
    assert!(
        fixture
            .pair
            .client
            .router()
            .has_notification(&ticks.as_like())
    );
    registration
        .unregister()
        .await
        .expect("the dropped registration removed");
    again
        .unregister()
        .await
        .expect("the new registration removed");
    fixture.dispose().await;
}

#[tokio::test]
async fn a_connection_that_closes_drops_its_notifications() {
    let fixture = Fixture::new().await;
    let ticks = fixture.ticks(None);
    let dropped = Arc::new(Mutex::new(Vec::new()));
    let hearing = Arc::clone(&dropped);
    fixture
        .pair
        .client
        .services()
        .on_dropped(Arc::new(move |_, failure| {
            locked(&hearing).push(failure.map(Failure::record));
        }));
    let registration = ticks
        .register(
            Value::Null,
            callback(&Arc::new(Mutex::new(Vec::new()))),
            &RegistrationOptions::default(),
        )
        .await
        .expect("registered");
    fixture
        .pair
        .transport
        .disconnect(&bead::TransportClientDisconnectOptions::default())
        .expect("the link closed");
    fixture.pair.settle().await;
    assert_eq!(*locked(&dropped), [None]);
    assert!(
        !fixture
            .pair
            .client
            .router()
            .has_notification(&ticks.as_like())
    );
    registration
        .unregister()
        .await
        .expect("the dropped registration removed");
    fixture.dispose().await;
}
