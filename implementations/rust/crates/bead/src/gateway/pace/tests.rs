//! A gateway's outlet: its head held until its first slice or its end, its slices taken as its
//! body is polled, its bounds, and what hears its end.

use core::pin::Pin;
use core::task::{Context, Poll, Waker};
use core::time::Duration;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use bytes::Bytes;
use http_body::Body;

use super::*;
use crate::clock::SystemClock;
use crate::gateway::body::HttpGatewayBody;
use crate::testing::patience;

const PATIENCE: Duration = Duration::from_secs(10);

// an outlet, what its head comes to, and what it reported
struct Made {
    outlet: Outlet,
    committed: oneshot::Receiver<Committed>,
    reported: Arc<Mutex<Vec<String>>>,
}

// an outlet held to `maximum` unsent bytes and a pace of `rate` past `grace`
fn outlet_of(maximum: u64, (rate, grace): (u64, Duration)) -> Made {
    let reported = Arc::new(Mutex::new(Vec::new()));
    let reporting = Arc::clone(&reported);
    let (outlet, committed) = Outlet::new(OutletSettings {
        maximum_unsent_bytes: maximum,
        pace: SendPaceOptions {
            minimum_send_bytes_per_second: rate,
            send_grace_period: grace,
        },
        platform: Arc::new(SystemClock::current().expect("a runtime")),
        flow: None,
        report: Arc::new(move |error| {
            reporting.lock().unwrap().push(error.to_string());
        }),
    });

    Made {
        outlet,
        committed,
        reported,
    }
}

fn head() -> Head {
    Head {
        status: 200,
        fields: vec![Field::of("content-type", "text/plain".to_owned())],
    }
}

// what a body gives when polled once, no waker heard
fn polled(body: &mut HttpGatewayBody) -> Poll<Option<Result<Bytes, String>>> {
    let mut context = Context::from_waker(Waker::noop());

    Pin::new(body).poll_frame(&mut context).map(|frame| {
        frame.map(|frame| {
            frame
                .map(|frame| frame.into_data().unwrap_or_default())
                .map_err(|error| error.to_string())
        })
    })
}

#[tokio::test]
async fn holds_its_head_until_its_first_slice_and_hands_each_slice_as_its_body_is_polled() {
    let Made {
        outlet,
        mut committed,
        reported,
    } = outlet_of(1_024, (0, Duration::from_secs(5)));

    outlet.head(head());
    assert!(committed.try_recv().is_err(), "no head before a slice");

    let first = outlet.write(Bytes::from_static(b"one"));
    let second = outlet.write(Bytes::from_static(b"two"));

    match committed.try_recv() {
        Ok(Committed::Head(given)) => assert_eq!(given, head(), "its head as given"),
        other => panic!("its head, not {other:?}"),
    }

    let mut body = HttpGatewayBody::over(outlet.shared());

    assert!(!body.is_end_stream(), "slices to come");
    assert_eq!(
        polled(&mut body),
        Poll::Ready(Some(Ok(Bytes::from_static(b"one"))))
    );
    assert!(first.await, "the first taken as polled");
    assert_eq!(
        polled(&mut body),
        Poll::Ready(Some(Ok(Bytes::from_static(b"two"))))
    );
    assert!(second.await, "the second taken");
    assert_eq!(polled(&mut body), Poll::Pending, "nothing more yet");
    outlet.end();
    assert!(body.is_end_stream(), "ended, every slice taken");
    assert_eq!(polled(&mut body), Poll::Ready(None), "its end");
    assert!(reported.lock().unwrap().is_empty(), "nothing reported");
}

#[tokio::test]
async fn writes_nothing_of_a_response_whose_first_slice_passes_maximum_unsent_bytes_reported() {
    let Made {
        outlet,
        mut committed,
        reported,
    } = outlet_of(5, (0, Duration::from_secs(5)));

    outlet.head(head());
    assert!(
        !outlet.write(Bytes::from_static(b"sixsix")).await,
        "the slice refused"
    );
    assert!(
        matches!(committed.try_recv(), Ok(Committed::Cut)),
        "cut before its head"
    );
    assert_eq!(
        *reported.lock().unwrap(),
        ["the response is dropped: maximumUnsentBytes 5 bytes"],
        "its bound named"
    );
    assert!(
        !outlet.write(Bytes::from_static(b"x")).await,
        "nothing more written"
    );
}

#[tokio::test]
async fn counts_the_slices_its_body_has_not_taken_with_the_one_it_would_add() {
    let Made {
        outlet, reported, ..
    } = outlet_of(6, (0, Duration::from_secs(5)));
    let mut body = HttpGatewayBody::over(outlet.shared());

    outlet.head(head());
    drop(outlet.write(Bytes::from_static(b"four")));
    assert!(
        !outlet.write(Bytes::from_static(b"two")).await,
        "4 waiting and 3 more pass 6"
    );
    assert_eq!(
        polled(&mut body),
        Poll::Ready(Some(Err("the gateway's response is cut".to_owned()))),
        "its body cut past its head"
    );
    assert_eq!(reported.lock().unwrap().len(), 1, "reported once");
}

#[tokio::test]
async fn ends_at_its_head_with_no_slice_its_body_ended_from_the_start() {
    let Made {
        outlet,
        mut committed,
        ..
    } = outlet_of(1_024, (0, Duration::from_secs(5)));

    outlet.head(head());
    outlet.end();
    assert!(
        matches!(committed.try_recv(), Ok(Committed::Head(_))),
        "its head at its end"
    );

    let body = HttpGatewayBody::over(outlet.shared());

    assert!(body.is_end_stream(), "nothing to poll");
    assert_eq!(body.size_hint().exact(), Some(0), "of no length");
}

#[tokio::test]
async fn tells_what_hears_its_end_once_its_body_is_let_go_and_takes_no_write_after() {
    let Made { outlet, .. } = outlet_of(1_024, (0, Duration::from_secs(5)));
    let heard = Arc::new(AtomicUsize::new(0));
    let hearing = Arc::clone(&heard);
    let body = HttpGatewayBody::over(outlet.shared());

    outlet.on_gone(Box::new(move || {
        hearing.fetch_add(1, Ordering::SeqCst);
    }));
    outlet.head(head());

    let waiting = outlet.write(Bytes::from_static(b"never polled"));

    drop(body);
    assert!(!waiting.await, "a slice never taken");
    assert_eq!(heard.load(Ordering::SeqCst), 1, "told once");
    outlet.shared().gone();
    assert_eq!(heard.load(Ordering::SeqCst), 1, "never twice");

    let late = Arc::new(AtomicUsize::new(0));
    let hearing = Arc::clone(&late);

    outlet.on_gone(Box::new(move || {
        hearing.fetch_add(1, Ordering::SeqCst);
    }));
    assert_eq!(late.load(Ordering::SeqCst), 1, "told at once once gone");
    assert!(
        !outlet.write(Bytes::from_static(b"x")).await,
        "no write once gone"
    );
}

#[tokio::test]
async fn drops_a_response_its_reader_leaves_unread_past_its_deadline_reported() {
    let Made {
        outlet, reported, ..
    } = outlet_of(1_024, (1_000_000, Duration::from_millis(1)));
    let mut body = HttpGatewayBody::over(outlet.shared());

    outlet.head(head());

    let waiting = outlet.write(Bytes::from_static(b"never read"));

    assert!(
        !patience(PATIENCE, waiting).await.expect("dropped in time"),
        "its slice never taken"
    );
    assert_eq!(
        *reported.lock().unwrap(),
        ["the response is dropped: minimumSendBytesPerSecond 1000000 after sendGracePeriod 1ms"],
        "its pace named"
    );
    assert!(
        matches!(polled(&mut body), Poll::Ready(Some(Err(_)))),
        "its body cut"
    );
}
