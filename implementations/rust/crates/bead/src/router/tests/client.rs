//! The client's router against bytes a test writes as a server would: its subscriptions, their
//! call ids let go of, their notifications forgotten, their pacing.

use core::time::Duration;
use std::sync::{Arc, Mutex};

use bytes::Bytes;
use tokio::sync::oneshot;

use super::{Scripted, failure_of, locked, notification_of, result_of, token};
use crate::constants::{EnvelopeKind, ProtocolCode};
use crate::envelope::{Credential, Envelope};
use crate::failure::Failure;
use crate::identity::Procedure;
use crate::router::client::{NotificationLike, Settled};
use crate::router::types::{BoxFuture, RouterActivity, RouterError};

/// A notification a test triggers and drops: it records the first byte of each payload and the
/// code of each failure its drop was told; its callbacks settle at once, unless held for the test
/// to settle, or its trigger fails as the test says.
#[derive(Debug)]
pub(super) struct Notified {
    procedure: Procedure,
    window: Option<u64>,
    is_held: bool,
    failing: Mutex<Option<String>>,
    triggered: Mutex<Vec<u8>>,
    held: Mutex<Vec<Option<oneshot::Sender<Settled>>>>,
    dropped: Mutex<Vec<Option<u16>>>,
}

impl Notified {
    pub(super) fn new(window: Option<u64>) -> Arc<Self> {
        Self::paced((super::notifying(), window))
    }

    // a notification of `procedure`, heard at once
    pub(super) fn of(procedure: Procedure) -> Arc<Self> {
        Self::paced((procedure, None))
    }

    fn paced((procedure, window): (Procedure, Option<u64>)) -> Arc<Self> {
        Arc::new(Self {
            procedure,
            window,
            is_held: window.is_some(),
            failing: Mutex::default(),
            triggered: Mutex::default(),
            held: Mutex::default(),
            dropped: Mutex::default(),
        })
    }

    pub(super) fn like(self: &Arc<Self>) -> Arc<dyn NotificationLike> {
        let like: Arc<dyn NotificationLike> = Arc::<Self>::clone(self);

        like
    }

    pub(super) fn fail_with(&self, message: &str) {
        *locked(&self.failing) = Some(message.to_owned());
    }

    pub(super) fn triggered(&self) -> Vec<u8> {
        locked(&self.triggered).clone()
    }

    pub(super) fn dropped(&self) -> Vec<Option<u16>> {
        locked(&self.dropped).clone()
    }

    // settles the callbacks of the notification triggered `index`th with `settled`
    pub(super) fn settle(&self, (index, settled): (usize, Settled)) {
        let sender = locked(&self.held).get_mut(index).and_then(Option::take);

        sender.expect("a notification held").send(settled).ok();
    }
}

impl NotificationLike for Notified {
    fn procedure(&self) -> &Procedure {
        &self.procedure
    }

    fn window(&self) -> Option<u64> {
        self.window
    }

    fn drop_with(&self, failure: Option<&Failure>) {
        locked(&self.dropped).push(failure.map(|failure| failure.code().get()));
    }

    fn trigger(&self, payload: Bytes) -> Result<BoxFuture<Settled>, RouterError> {
        locked(&self.triggered).push(payload.first().copied().unwrap_or_default());

        let failing = locked(&self.failing).clone();

        if let Some(message) = failing {
            return Err(RouterError::Other(Arc::new(std::io::Error::other(message))));
        }

        if !self.is_held {
            return Ok(Box::pin(async { Vec::new() }));
        }

        // settled where the test settles it, so the router hears of it in that turn
        let (sender, settled) = oneshot::channel();

        locked(&self.held).push(Some(sender));

        Ok(Box::pin(async move { settled.await.unwrap_or_default() }))
    }
}

// spec 11.7, 12.9.2, 12.9.3
#[tokio::test]
async fn keeps_the_call_id_of_a_subscription_let_go_of_a_while_silent_on_what_comes_under_it_then_reports_it()
 {
    let scripted = Scripted::new();
    let notification = Notified::new(None);
    let given = Duration::from_millis(20);
    let ending = failure_of(1, (ProtocolCode::SESSION_REQUIRED, Some(Credential::None)));

    let subscribing = scripted.subscribe((&notification.like(), given)).await;

    scripted
        .transport
        .deliver(&result_of(1, Some(Credential::Opaque(token()))));
    super::answered(subscribing).await.expect("subscribed");
    scripted
        .router
        .unregister_notification((&notification.like(), true))
        .await;

    // on its way when it was let go of: dropped in silence, and so is the failure that ends it,
    // whose end of session is learned all the same
    scripted.transport.deliver(&notification_of(1, 5));
    scripted.transport.deliver(&ending);
    scripted.settle().await;

    assert_eq!(
        scripted.codes(),
        Vec::<String>::new(),
        "nothing reported while reserved"
    );
    assert_eq!(scripted.router.session_token(), None, "its session ended");

    scripted.clock.advance(given).await;
    scripted.transport.deliver(&notification_of(1, 5));
    scripted.transport.deliver(&ending);
    scripted.settle().await;

    assert_eq!(
        scripted.codes(),
        ["SUBSCRIPTION_UNKNOWN", "CALL_UNKNOWN"],
        "reported once its reservation ended"
    );
}

// spec 11.7, 12.9.3
#[tokio::test]
async fn reports_a_notification_under_no_subscription_and_one_whose_callback_throws() {
    let scripted = Scripted::new();
    let throwing = Notified::new(None);
    let activity: Arc<Mutex<Vec<RouterActivity>>> = Arc::default();
    let hearing = Arc::clone(&activity);

    throwing.fail_with("callback failed");
    scripted
        .router
        .on_activity(Arc::new(move |what: RouterActivity| {
            locked(&hearing).push(what);
        }));
    scripted.transport.deliver(&notification_of(1, 5));
    scripted.settle().await;

    let subscribing = scripted.subscribe((&throwing.like(), super::TIMEOUT)).await;

    scripted.transport.deliver(&result_of(1, None));
    super::answered(subscribing).await.expect("subscribed");
    scripted.transport.deliver(&notification_of(1, 5));
    scripted.settle().await;

    assert_eq!(
        scripted.codes(),
        ["SUBSCRIPTION_UNKNOWN", "callback failed"],
        "the stray and the failed callback reported"
    );

    let first = locked(&scripted.errors).first().cloned();

    assert!(
        matches!(&first, Some(RouterError::Failure(failure)) if failure.detail() == "no subscription under call 1"),
        "the stray named by its call: {first:?}"
    );

    // the first, under no subscription, is not told as activity; the second is, though its
    // trigger failed: this side triggers on its router's owner, so it tells a notification as it
    // arrives, as the C# side does
    assert_eq!(
        locked(&activity)
            .iter()
            .filter(|what| **what == RouterActivity::Notification)
            .count(),
        1,
        "one notification told"
    );
}

// spec 12.9.2
#[tokio::test]
async fn a_failure_after_its_result_ends_the_subscription_no_call_unknown_the_notification_told_the_next_registration_asks_anew()
 {
    let scripted = Scripted::new();
    let notification = Notified::new(None);

    let subscribing = scripted
        .subscribe((&notification.like(), super::TIMEOUT))
        .await;

    scripted
        .transport
        .deliver(&result_of(1, Some(Credential::Opaque(token()))));
    super::answered(subscribing).await.expect("subscribed");

    // the session ended: the server ends the subscription, and announces the end; one on its way
    // behind it is dropped in silence
    scripted.transport.deliver(&failure_of(
        1,
        (ProtocolCode::SESSION_REQUIRED, Some(Credential::None)),
    ));
    scripted.transport.deliver(&notification_of(1, 5));
    scripted.settle().await;

    assert_eq!(scripted.codes(), Vec::<String>::new(), "nothing reported");
    assert_eq!(notification.dropped(), [Some(32)], "told what ended it");
    assert_eq!(
        notification.triggered(),
        Vec::<u8>::new(),
        "the one behind it dropped"
    );
    assert_eq!(scripted.router.session_token(), None, "its session ended");
    assert!(
        !scripted.router.has_notification(&notification.like()),
        "no longer held"
    );

    // registered again, it subscribes with a request of its own
    let again = scripted
        .subscribe((&notification.like(), super::TIMEOUT))
        .await;

    scripted.transport.deliver(&result_of(3, None));
    super::answered(again).await.expect("subscribed again");
    scripted.transport.deliver(&notification_of(3, 5));
    scripted.settle().await;

    assert_eq!(notification.triggered(), [5], "heard under its new call");
    assert_eq!(
        scripted.transport.calls(),
        [(EnvelopeKind::Request, 1), (EnvelopeKind::Request, 3)],
        "two requests, no cancel"
    );

    // a failure on no subscription answers nothing
    scripted
        .transport
        .deliver(&failure_of(9, (ProtocolCode::SESSION_REQUIRED, None)));
    scripted.settle().await;

    assert_eq!(
        scripted.codes(),
        ["CALL_UNKNOWN"],
        "a failure under no call reported"
    );
}

// spec 11.7.3
#[tokio::test]
async fn forgets_each_notification_when_its_connection_closes_is_replaced_or_it_is_disposed_and_tells_it()
 {
    let scripted = Scripted::new();
    let (closed, replaced, disposed) = (
        Notified::new(None),
        Notified::new(None),
        Notified::new(None),
    );

    let subscribing = scripted.subscribe((&closed.like(), super::TIMEOUT)).await;

    scripted.transport.deliver(&result_of(1, None));
    super::answered(subscribing).await.expect("subscribed");
    scripted.transport.close_connection();
    scripted.settle().await;

    assert_eq!(closed.dropped(), [None], "told with no failure");
    assert!(
        !scripted.router.has_notification(&closed.like()),
        "forgotten with its connection"
    );

    // nothing is bound any more: what comes under the old call id is reported
    scripted.transport.deliver(&notification_of(1, 5));
    scripted.settle().await;

    assert_eq!(
        scripted.codes(),
        ["SUBSCRIPTION_UNKNOWN"],
        "the old call id unbound"
    );

    // its connection replaced, as a reconnection starts
    scripted
        .router
        .register_notification(replaced.like())
        .expect("registered");
    scripted.transport.replace();
    scripted.settle().await;

    assert_eq!(
        replaced.dropped(),
        [None],
        "told as its connection was replaced"
    );
    assert!(
        !scripted.router.has_notification(&replaced.like()),
        "forgotten as replaced"
    );

    scripted
        .router
        .register_notification(disposed.like())
        .expect("registered");
    scripted.router.dispose().await;
    scripted.settle().await;

    assert_eq!(closed.dropped().len(), 1, "the closed told once");
    assert_eq!(replaced.dropped().len(), 1, "the replaced told once");
    assert_eq!(
        disposed.dropped(),
        [None],
        "told as its router was disposed"
    );
    assert!(
        !scripted.router.has_notification(&disposed.like()),
        "forgotten as disposed"
    );
}

// spec 11.11
#[tokio::test]
async fn opens_its_window_once_subscribed_and_renews_it_once_half_a_window_settled() {
    let scripted = Scripted::new();
    let notification = Notified::new(Some(4));

    let subscribing = scripted
        .subscribe((&notification.like(), super::TIMEOUT))
        .await;

    scripted.transport.deliver(&result_of(1, None));
    super::answered(subscribing).await.expect("subscribed");
    scripted.settle().await;

    assert_eq!(scripted.transport.credits(), [4], "its window opened");

    for value in [1, 2, 3, 4] {
        scripted.transport.deliver(&notification_of(1, value));
    }

    scripted.settle().await;
    scripted.done((&notification, 0)).await;

    assert_eq!(scripted.transport.credits(), [4], "a quarter settled");

    scripted.done((&notification, 1)).await;

    assert_eq!(
        scripted.transport.credits(),
        [4, 6],
        "half a window settled"
    );

    // settled out of order, counted all the same
    scripted.done((&notification, 3)).await;
    scripted.done((&notification, 2)).await;

    assert_eq!(scripted.transport.credits(), [4, 6, 8], "renewed again");
}

// spec 11.11
#[tokio::test]
async fn asks_for_its_subscription_paced_and_credits_each_notification_once_its_callbacks_settled()
{
    let scripted = Scripted::new();
    let notification = Notified::new(Some(1));

    let subscribing = scripted
        .subscribe((&notification.like(), super::TIMEOUT))
        .await;

    scripted.transport.deliver(&result_of(1, None));
    super::answered(subscribing).await.expect("subscribed");
    scripted.settle().await;

    let asked = scripted.transport.envelopes().first().cloned();

    assert!(
        matches!(&asked, Some(Envelope::Request { header, .. }) if header.opens_subscription && header.paced),
        "asked paced: {asked:?}"
    );

    // the first is credited by asking
    assert_eq!(
        scripted.transport.credits(),
        Vec::<u64>::new(),
        "no credit yet"
    );

    scripted.transport.deliver(&notification_of(1, 1));
    scripted.settle().await;

    assert_eq!(
        scripted.transport.credits(),
        Vec::<u64>::new(),
        "none as it came"
    );

    // * credited once its callbacks settled, not as it came
    scripted.done((&notification, 0)).await;

    assert_eq!(scripted.transport.credits(), [2], "credited once settled");

    scripted.transport.deliver(&notification_of(1, 2));
    scripted.settle().await;
    scripted.done((&notification, 1)).await;

    assert_eq!(notification.triggered(), [1, 2], "both heard");
    assert_eq!(scripted.transport.credits(), [2, 3], "each credited");
    assert_eq!(scripted.codes(), Vec::<String>::new(), "nothing reported");
}

// spec 11.11
#[tokio::test]
async fn credits_a_notification_ahead_of_its_result_and_its_window_after_no_further_than_it_reaches()
 {
    let scripted = Scripted::new();
    let notification = Notified::new(Some(2));

    let subscribing = scripted
        .subscribe((&notification.like(), super::TIMEOUT))
        .await;

    scripted.transport.deliver(&notification_of(1, 5));
    scripted.settle().await;
    scripted.done((&notification, 0)).await;

    assert_eq!(
        scripted.transport.credits(),
        [3],
        "credited ahead of its result"
    );

    scripted.transport.deliver(&result_of(1, None));
    super::answered(subscribing).await.expect("subscribed");
    scripted.settle().await;

    assert_eq!(
        scripted.transport.credits(),
        [3],
        "its window no further than it reaches"
    );
}
