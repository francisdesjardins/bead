//! The MQTT client's packet ordering, parser refusal, keep-alive and panic boundary. MQTT.js and
//! `MQTTnet` own these mechanisms on the other sides; these exercise Bead's Rust-native client.

use super::*;

#[tokio::test]
#[cfg_attr(
    windows,
    ignore = "fixture: a small receive window blocks no writer on Windows, so the stop settles before its deadline; Linux runs it"
)]
async fn resets_its_socket_once_its_disconnect_cannot_leave_within_its_connect_timeout() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::sync::oneshot;

    use crate::testing::SteppingClock;

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let (reading, read) = oneshot::channel::<()>();
    let peer = spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();

        // the peer keeps a small receive window and reads no publication until the stop settles
        socket2::SockRef::from(&socket)
            .set_recv_buffer_size(1_024)
            .unwrap();

        let mut header = [0; 2];

        socket.read_exact(&mut header).await.unwrap();
        assert_eq!(header[0], 0x10, "its first packet is a CONNECT");
        assert!(
            header[1] < 128,
            "the short CONNECT has one Remaining Length byte"
        );

        let mut connect = vec![0; usize::from(header[1])];

        socket.read_exact(&mut connect).await.unwrap();
        socket
            .write_all(&connack(&Connack::default()))
            .await
            .unwrap();
        read.await.unwrap();

        let failed = socket.read_to_end(&mut Vec::new()).await.unwrap_err();

        assert_eq!(
            failed.kind(),
            std::io::ErrorKind::ConnectionReset,
            "the timed-out stop resets its blocked socket"
        );
    });
    let clock = SteppingClock::new(crate::testing::instants::new_year());
    let timeout = Duration::from_millis(100);
    let mut options = MqttBrokerAdapterOptions::new(format!("mqtt://127.0.0.1:{port}"), ID);

    options.password = Some(PASSWORD.to_owned());
    options.clock = Some(Arc::<SteppingClock>::clone(&clock));
    options.delivery = Some(BrokerDelivery::AtMostOnce);
    options.connect_timeout = Some(timeout);

    let adapter = adapter_of(&options);
    let heard = heard_of(&adapter);

    adapter.start(BrokerStart::default()).await.unwrap();

    // * handed to its writer as it is made, and taken only once written, which it never is
    let publishing = spawn(adapter.publish(BrokerPublication::new(
        inbox(),
        Bytes::from(vec![0; 8_388_608]),
    )));
    let stopping = spawn(adapter.stop());

    until(|| clock.dues().contains(&timeout)).await;
    assert!(
        !stopping.is_finished(),
        "the blocked DISCONNECT waits within its own timeout"
    );
    clock.advance(timeout).await;
    crate::testing::patience(PATIENCE, stopping)
        .await
        .unwrap()
        .unwrap();
    assert!(!adapter.is_linked(), "its stop settles after the deadline");
    assert_eq!(
        message_of(
            &crate::testing::patience(PATIENCE, publishing)
                .await
                .unwrap()
                .unwrap()
                .unwrap_err()
        ),
        "the link of ada stopped",
        "the QoS 0 publication never written fails with its stop"
    );
    assert!(
        heard.downs().is_empty(),
        "its own stop reports no link loss"
    );
    reading.send(()).unwrap();
    crate::testing::patience(PATIENCE, peer)
        .await
        .unwrap()
        .unwrap();
}

#[tokio::test]
async fn keeps_passwords_and_provider_details_out_of_its_debug_output() {
    let script = script().await;
    let options = options_of(&script);
    let shown = format!("{options:?}");

    assert!(
        shown.contains("has_password: true"),
        "the presence of a password is visible"
    );
    assert!(!shown.contains(PASSWORD), "its password is not printed");
    assert!(!shown.contains("runtime:"), "its runtime stays opaque");

    let adapter = adapter_of(&options);
    let shown = format!("{adapter:?}");

    assert_eq!(
        shown, "MqttBrokerAdapter { id: \"ada\", url: \"127.0.0.1\", .. }",
        "its adapter identifies the link without its authentication"
    );
    adapter.stop().await;

    let mut options = options;

    options.password = None;
    options.password_provider = Some(provider_of(|_signal| {
        Box::pin(async { Ok(PASSWORD.to_owned()) })
    }));

    let shown = format!("{options:?}");

    assert!(
        shown.contains("has_password_provider: true"),
        "its provider is named by its presence"
    );
    assert!(
        !shown.contains(PASSWORD),
        "its provider's secret is not printed"
    );
    script.dispose();
}

#[tokio::test]
async fn fails_its_start_on_a_disconnect_or_another_packet_before_its_connack() {
    for (packet, reason) in [
        (disconnect(0x87), "DISCONNECT 0x87, Not authorized"),
        (pingresp(), "its broker sent another packet first"),
    ] {
        let script = script().await;
        let adapter = adapter_of(&options_of(&script));
        let heard = heard_of(&adapter);
        let starting = adapter.start(BrokerStart::default());
        let link = script.link(PATIENCE).await.unwrap();

        link.send(packet);

        let failure = crate::testing::patience(PATIENCE, starting)
            .await
            .unwrap()
            .unwrap_err();

        assert_eq!(
            message_of(&failure),
            format!("the link of ada ended before its CONNACK: {reason}"),
            "the packet refuses its start"
        );
        assert!(!adapter.is_linked(), "it never links");
        assert!(heard.downs().is_empty(), "an unopened link reports no loss");
        adapter.stop().await;
        script.dispose();
    }
}

#[tokio::test]
async fn loses_its_link_on_a_second_connack_or_a_malformed_packet() {
    for packet in [connack(&Connack::default()), vec![0x41, 0x02, 0, 1]] {
        let script = script().await;
        let adapter = adapter_of(&options_of(&script));
        let heard = heard_of(&adapter);
        let link = link_up((&adapter, &script), (&Connack::default(), None)).await;

        link.send(packet);
        until(|| !heard.downs().is_empty()).await;
        assert_eq!(
            heard.downs(),
            vec![down(false)],
            "the invalid packet loses its link once"
        );
        assert!(
            !adapter.is_linked(),
            "not linked after its protocol refusal"
        );
        assert!(link.closed(PATIENCE).await, "its connection ends");
        assert!(
            link.of(Kind::Disconnect).is_empty(),
            "no clean DISCONNECT on its failed connection"
        );
        adapter.stop().await;
        script.dispose();
    }
}

#[tokio::test]
async fn loses_its_link_once_its_pingreq_has_no_pingresp_within_its_keep_alive() {
    let script = script().await;
    let mut options = options_of(&script);

    options.keep_alive = Some(Duration::from_secs(1));

    let adapter = adapter_of(&options);
    let heard = heard_of(&adapter);
    let link = link_up((&adapter, &script), (&Connack::default(), None)).await;

    link.next(Some(Kind::Pingreq), PATIENCE).await.unwrap();
    assert!(
        adapter.is_linked(),
        "its unanswered PINGREQ has one Keep Alive to wait"
    );
    assert!(heard.downs().is_empty(), "sending its ping loses nothing");
    until(|| !heard.downs().is_empty()).await;
    assert_eq!(
        heard.downs(),
        vec![down(false)],
        "an unanswered PINGREQ loses its link"
    );
    assert!(!adapter.is_linked(), "down");
    assert!(link.closed(PATIENCE).await, "the unanswered socket ends");
    assert!(
        link.of(Kind::Disconnect).is_empty(),
        "no DISCONNECT after its keep-alive refusal"
    );
    adapter.stop().await;
    script.dispose();
}

#[tokio::test]
async fn catches_a_password_provider_s_panic_as_it_is_called_or_polled_before_any_socket_opens() {
    let script = script().await;

    for provider in [
        provider_of(|_signal| panic!("the vault panics")),
        provider_of(|_signal| Box::pin(async { panic!("the vault panics") })),
    ] {
        let mut options = options_of(&script);

        options.password = None;
        options.password_provider = Some(provider);

        let adapter = adapter_of(&options);
        let failure = adapter.start(BrokerStart::default()).await.unwrap_err();

        assert_eq!(
            message_of(&failure),
            "the password provider failed",
            "the panic fails its start"
        );
        assert!(
            std::error::Error::source(&failure)
                .is_some_and(|cause| cause.to_string().contains("the vault panics")),
            "its panic is the cause: {failure:?}"
        );
        assert!(!adapter.is_linked(), "no link opens");
        adapter.stop().await;
    }

    assert!(
        script.link(Duration::from_millis(50)).await.is_err(),
        "no CONNECT reaches its broker"
    );
    script.dispose();
}
