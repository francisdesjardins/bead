//! Notification cancellation, the exact drop failure and a failed trigger's trace.

use std::sync::Arc;

use bytes::Bytes;

use super::notifications::{Heard, callback, notification, procedure, subscribed};
use super::{ClientFixture, locked};
use crate::constants::{ProtocolCode, RouterSide};
use crate::debug::DebugType;
use crate::envelope::{CancelHeader, Envelope};
use crate::errors::ProgrammerError;
use crate::failure::Failure;
use crate::managers::service::{
    NotificationDependencies, RegistrationOptions, RequestDependencies,
};
use crate::payloads::{CodecRefusal, PayloadCodec, TextCodec};
use crate::router::types::RouterError;

#[derive(Debug)]
struct Nonempty;

impl PayloadCodec for Nonempty {
    type Value = String;

    fn decode(&self, bytes: &Bytes) -> Result<String, CodecRefusal> {
        if bytes.is_empty() {
            return Err(CodecRefusal::new("empty"));
        }
        TextCodec.decode(bytes)
    }

    fn encode(&self, value: &String) -> Result<Bytes, CodecRefusal> {
        TextCodec.encode(value)
    }

    fn encoding(&self) -> &'static str {
        "text"
    }
}

#[tokio::test]
async fn without_an_unsubscribe_the_router_is_told_to_cancel() {
    let fixture = ClientFixture::new();
    let notification = notification(&fixture);
    let registration = subscribed(&fixture, (&notification, callback(&Heard::default(), ""))).await;
    let requests = fixture.transport.envelopes();

    registration
        .unregister()
        .await
        .expect("the registration leaves");
    fixture.clock.settle().await;

    assert_eq!(
        fixture.transport.envelopes()[requests.len()..],
        [Envelope::Cancel {
            header: CancelHeader { call_id: 1 }
        }]
    );
    assert!(!fixture.router.has_notification(&notification.as_like()));
    fixture.router.dispose().await;
}

#[tokio::test]
async fn a_drop_tells_the_manager_the_failure_the_other_end_ended_its_subscription_with() {
    let fixture = ClientFixture::new();
    let notification = notification(&fixture);
    let dropped = Arc::new(std::sync::Mutex::new(Vec::new()));
    let hearing = Arc::clone(&dropped);
    fixture
        .manager
        .on_dropped(Arc::new(move |procedure, failure| {
            locked(&hearing).push((procedure.clone(), failure.map(Failure::record)));
        }));
    let failure =
        Failure::protocol(ProtocolCode::CAPACITY_EXCEEDED, RouterSide::Client).saying("too many");

    notification.as_like().drop_with(Some(&failure));

    assert_eq!(*locked(&dropped), [(procedure(), Some(failure.record()))]);
    assert_eq!(fixture.transport.envelopes(), []);
    fixture.router.dispose().await;
}

#[tokio::test]
async fn a_trigger_never_registered_is_a_programmer_error_a_payload_that_does_not_decode_a_failure_traced()
 {
    let fixture = ClientFixture::new();
    let heard = Heard::default();
    let traced = Arc::new(std::sync::Mutex::new(Vec::new()));
    let hearing = Arc::clone(&traced);
    fixture.manager.on_debug(Arc::new(move |error, event| {
        if event.call_type == DebugType::Notification {
            let failure = error
                .and_then(|error| error.downcast_ref::<RouterError>())
                .and_then(|error| {
                    if let RouterError::Failure(failure) = error {
                        Some(failure.record())
                    } else {
                        None
                    }
                });
            locked(&hearing).push((failure, event.rx.is_none()));
        }
    }));
    let notification = fixture
        .manager
        .get_notification(
            &procedure(),
            NotificationDependencies::new(RequestDependencies::new(TextCodec, TextCodec), Nonempty),
        )
        .expect("declared");
    let early = notification.as_like().trigger(Bytes::from_static(b"early"));
    assert!(
        matches!(early, Err(RouterError::Other(error)) if error.downcast_ref::<ProgrammerError>().is_some())
    );
    let mut registering = notification.register(
        "s".to_owned(),
        callback(&heard, ""),
        &RegistrationOptions::default(),
    );
    super::notifications::pending(&mut registering).await;
    fixture.clock.settle().await;
    fixture
        .transport
        .deliver(&super::notifications::result(1, b"subscribed"));
    let registration = registering.await.expect("subscribed");

    let triggered = notification.as_like().trigger(Bytes::new());

    let Err(RouterError::Failure(failure)) = triggered else {
        panic!("an empty notification fails its read");
    };
    assert_eq!(failure.code(), ProtocolCode::PAYLOAD_UNDECODABLE.get());
    assert_eq!(failure.detail(), "empty");
    assert_eq!(*locked(&traced), [(Some(failure.record()), true)]);
    assert_eq!(*locked(&heard), Vec::<String>::new());
    registration
        .unregister()
        .await
        .expect("the registration leaves");
    fixture.router.dispose().await;
}
