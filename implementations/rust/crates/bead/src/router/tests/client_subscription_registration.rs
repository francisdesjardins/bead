//! A subscribing request names the very procedure its held notification belongs to.

use bytes::Bytes;

use super::client::Notified;
use super::{Scripted, TIMEOUT, request_of};

#[tokio::test]
async fn binds_no_notification_the_router_does_not_hold_for_the_procedure() {
    let scripted = Scripted::new();
    let held = Notified::new(None);
    scripted
        .router
        .request(Bytes::new(), request_of((Some(held.like()), TIMEOUT)))
        .expect_err("the notification is not held");
    scripted
        .router
        .register_notification(held.like())
        .expect("registered");
    scripted
        .router
        .request(
            Bytes::new(),
            request_of((Some(Notified::new(None).like()), TIMEOUT)),
        )
        .expect_err("another notification of the procedure is not held");
    let mut mismatch = request_of((Some(held.like()), TIMEOUT));
    mismatch.procedure.procedure_id = 9;
    scripted
        .router
        .request(Bytes::new(), mismatch)
        .expect_err("the notification belongs to another procedure");
    scripted.settle().await;
    assert_eq!(scripted.transport.sent().len(), 0);
}
