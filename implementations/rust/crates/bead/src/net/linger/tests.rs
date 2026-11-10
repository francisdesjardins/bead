use core::time::Duration;
use std::sync::Arc;
use std::time::SystemTime;

use tokio::io::{AsyncReadExt, AsyncWriteExt};

use super::*;
use crate::testing::{SteppingClock, patience, spawn, yield_now};

const PATIENCE: Duration = Duration::from_secs(10);

#[tokio::test]
async fn reads_on_once_its_answer_is_written_and_destroys_the_socket_once_its_client_ends_it() {
    let clock: SharedClock = SteppingClock::new(SystemTime::UNIX_EPOCH);
    let (mut server, mut client) = tokio::io::duplex(64);

    server
        .write_all(b"HTTP/1.1 400 Bad Request\r\n\r\n")
        .await
        .unwrap();

    let lingering = spawn(async move { close_in_stages(server, &clock).await });
    let mut answer = Vec::new();

    // its write side shut: its answer read whole, to its end
    patience(PATIENCE, client.read_to_end(&mut answer))
        .await
        .unwrap()
        .unwrap();

    assert_eq!(
        answer, b"HTTP/1.1 400 Bad Request\r\n\r\n",
        "its answer whole"
    );

    // what its client still sends is read and dropped, never a reset
    client.write_all(b"the rest of a body").await.unwrap();
    client.flush().await.unwrap();

    assert!(!lingering.is_finished(), "it reads on");

    drop(client);
    patience(PATIENCE, lingering).await.unwrap().unwrap();
}

#[tokio::test]
async fn destroys_a_socket_whose_client_never_ends_it_after_2_s_on_the_platform_s_clock() {
    let stepping = SteppingClock::new(SystemTime::UNIX_EPOCH);
    let clock: SharedClock = Arc::<SteppingClock>::clone(&stepping);
    let (server, mut client) = tokio::io::duplex(64);
    let lingering = spawn(async move { close_in_stages(server, &clock).await });
    let mut answer = Vec::new();

    patience(PATIENCE, client.read_to_end(&mut answer))
        .await
        .unwrap()
        .unwrap();

    patience(PATIENCE, async {
        while stepping.dues().is_empty() {
            yield_now().await;
        }
    })
    .await
    .unwrap();

    assert_eq!(stepping.dues(), vec![Duration::from_secs(2)], "2 s armed");

    stepping.advance(Duration::from_secs(2)).await;
    patience(PATIENCE, lingering).await.unwrap().unwrap();

    assert!(stepping.dues().is_empty(), "nothing armed after it");
}
