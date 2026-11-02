//! A subscription is removed by its call address, with no change on another connection.

use super::server::{Served, first, second, subscribing_of};
use crate::router::server::RouterServerOptions;
use crate::router::types::CallAddress;

#[tokio::test]
async fn unsubscribe_takes_a_connections_own_subscription_away_by_its_call_id_and_no_others() {
    let served = Served::new(&RouterServerOptions::default());
    served.transport.open(&first(), true);
    served.transport.open(&second(), true);
    served.news();
    served.transport.deliver(&subscribing_of(11), &first());
    served.settle().await;
    for (handle, call_id, held) in [
        (second(), 11, false),
        (first(), 13, false),
        (first(), 11, true),
        (first(), 11, false),
    ] {
        assert_eq!(
            served
                .router
                .unsubscribe(CallAddress {
                    connection_handle: handle,
                    call_id,
                })
                .await,
            held
        );
    }
    served
        .router
        .owner()
        .run(|state| {
            assert_eq!(state.notifications.subscriptions(None), Vec::new());
        })
        .await
        .expect("no subscription remains");
    assert_eq!(served.sent_since(), ["first result 11 ok"]);
    assert_eq!(served.reported(), Vec::<String>::new());
    served.router.dispose().await;
    assert!(
        !served
            .router
            .unsubscribe(CallAddress {
                connection_handle: first(),
                call_id: 11,
            })
            .await
    );
}
