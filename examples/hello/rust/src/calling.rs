//! `HelloService`'s Rust client: it calls the server on 127.0.0.1, and writes what each call
//! answered, a line each, which the TypeScript and C# clients write alike.

use core::time::Duration;
use std::error::Error;
use std::io::{self, Write};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use bead::{
    BoxFuture, CallError, ProtocolCode, RegistrationOptions, RequestOptions,
    TransportClientDisconnectOptions, WebSocketClient, WebSocketClientOptions,
    WebSocketTransportClientConnectOptions,
};
use tokio::runtime::Builder;
use tokio::sync::Notify;

use crate::generated::messages::hello::v1::{
    AskNameResponse, CountDownRequest, SayHelloRequest, Tick,
};
use crate::generated::services::hello::v1::{
    HelloClient, HelloClientOptions, HelloFailures, HelloWindows,
};

// the address its server listens on
const HOST: &str = "127.0.0.1";

// the name it answers askName with, the first time it is asked; an empty one after
const NAME: &str = "Ada";

// how long each countDown callback holds itself, so ticks the window did not pace overlap
const HOLD: Duration = Duration::from_millis(10);

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

// LF, as the other halves write it, on every platform
fn say(line: &str) -> Result<(), String> {
    writeln!(io::stdout().lock(), "{line}").map_err(|error| format!("a line not said: {error}"))
}

// what a refused or failed call answered: a failure of `HelloService`'s catalogue by its name, an
// admission refused by its detail, a request its rules refused by its violations, the detail's
// lines as they came; anything else fails the run
fn failure_of(error: &CallError) -> Result<String, String> {
    let CallError::Failure(failure) = error else {
        return Err(error.to_string());
    };
    let named = if HelloFailures::is(error, &HelloFailures::NAMELESS) {
        "NAMELESS"
    } else if failure.is_protocol_code(&[ProtocolCode::ACCESS_DENIED]) {
        "ACCESS_DENIED"
    } else if failure.is_protocol_code(&[ProtocolCode::PAYLOAD_INVALID]) {
        "PAYLOAD_INVALID"
    } else {
        return Err(error.to_string());
    };

    Ok(format!("{named}, {}", failure.detail()))
}

// the line of a call that must fail: what it failed with, a call that answered failing the run
fn refusal_of<T>(answered: Result<T, CallError>) -> Result<String, String> {
    match answered {
        Ok(_) => Err("a call its server must refuse was answered".to_owned()),
        Err(error) => failure_of(&error),
    }
}

// the callbacks of countDown's notification while they run, and the most of them that ran at once
#[derive(Default)]
struct Counting {
    ticks: Vec<i32>,
    in_flight: u32,
    most: u32,
}

// countDown from 3 through its notification, at the window the client side was given: the ticks
// in the order they came, and how many of its callbacks ran at once, each holding itself HOLD
async fn counted_down(hello: &HelloClient) -> Result<String, String> {
    // * the callbacks counted while they run: at a window of 1, one at a time, by construction;
    // unpaced, they would run at once on the runtime's workers, so the count is kept under a lock
    let counting = Arc::new(Mutex::new(Counting::default()));
    let counted = Arc::new(Notify::new());
    let heard = Arc::clone(&counting);
    let ended = Arc::clone(&counted);
    let callback = move |tick: Tick| -> BoxFuture<Result<(), Arc<dyn Error + Send + Sync>>> {
        let heard = Arc::clone(&heard);
        let ended = Arc::clone(&ended);

        Box::pin(async move {
            {
                let mut counting = locked(&heard);

                counting.in_flight = counting.in_flight.saturating_add(1);
                counting.most = counting.most.max(counting.in_flight);
                counting.ticks.push(tick.remaining);
            }

            // a callback that takes its time: the window holds the next tick until it settles
            tokio::time::sleep(HOLD).await;

            {
                let mut counting = locked(&heard);

                counting.in_flight = counting.in_flight.saturating_sub(1);
            }

            if tick.remaining == 0 {
                ended.notify_one();
            }

            Ok(())
        })
    };
    let registration = hello
        .notifications()
        .count_down
        .register(
            CountDownRequest {
                from: 3,
                ..CountDownRequest::default()
            },
            Arc::new(callback),
            &RegistrationOptions::default(),
        )
        .await
        .map_err(|error| error.to_string())?;

    counted.notified().await;
    registration
        .unregister()
        .await
        .map_err(|error| error.to_string())?;

    let counting = locked(&counting);
    let ticks: Vec<String> = counting.ticks.iter().map(ToString::to_string).collect();
    let most = if counting.most == 1 {
        "one".to_owned()
    } else {
        counting.most.to_string()
    };

    Ok(format!("{}, {most} at a time", ticks.join(" ")))
}

/// Calls `HelloService` on `port`, and writes what it answered.
///
/// # Errors
///
/// What failed, in words: the runtime, the client, its connect, a call answered otherwise than
/// its server answers it, or a line unsaid.
pub(crate) fn call(port: u16) -> Result<(), String> {
    Builder::new_multi_thread()
        .enable_all()
        .build()
        .map_err(|error| format!("no runtime: {error}"))?
        .block_on(calls(port))
}

// the client, its calls made, then disposed of whatever they answered
async fn calls(port: u16) -> Result<(), String> {
    let client = WebSocketClient::new(&WebSocketClientOptions::default())
        .map_err(|error| error.to_string())?;
    let called = calls_on(&client, port).await;

    client.dispose().await;

    called
}

async fn calls_on(client: &WebSocketClient, port: u16) -> Result<(), String> {
    // at a window of 1: each tick comes once the callback before it settled
    let options = HelloClientOptions {
        windows: Some(HelloWindows {
            count_down: Some(1),
        }),
        ..HelloClientOptions::default()
    };
    let hello = HelloClient::new(client.client(), &options).map_err(|error| error.to_string())?;
    let asked = AtomicU32::new(0);

    hello
        .on_ask_name(move |_request, response| {
            let is_first = asked.fetch_add(1, Ordering::SeqCst) == 0;

            async move {
                response
                    .result(AskNameResponse {
                        name: if is_first { NAME } else { "" }.to_owned(),
                        ..AskNameResponse::default()
                    })
                    .await
            }
        })
        .map_err(|error| error.to_string())?;

    client
        .connect(&WebSocketTransportClientConnectOptions::new(HOST, port))
        .await
        .map_err(|error| error.to_string())?;

    let request = hello.request();
    let options = RequestOptions::default();
    let counting_down = |from| {
        request.count_down.call(
            CountDownRequest {
                from,
                ..CountDownRequest::default()
            },
            &options,
        )
    };
    let saying_hello = |name: &str| {
        request.say_hello.call(
            SayHelloRequest {
                name: name.to_owned(),
                ..SayHelloRequest::default()
            },
            &options,
        )
    };

    let refused = counting_down(3).map_err(|error| error.to_string())?.await;

    say(&format!(
        "countDown before sayHello: {}",
        refusal_of(refused)?
    ))?;

    for (line, name) in [("sayHello Bead", "Bead"), ("sayHello, nameless", "")] {
        let answer = saying_hello(name)
            .map_err(|error| error.to_string())?
            .await
            .map_err(|error| error.to_string())?;

        say(&format!("{line}: {}", answer.greeting))?;
    }

    let refused = counting_down(11).map_err(|error| error.to_string())?.await;

    say(&format!("countDown from 11: {}", refusal_of(refused)?))?;
    say(&format!(
        "countDown from 3: {}",
        counted_down(&hello).await?
    ))?;

    let refused = saying_hello("").map_err(|error| error.to_string())?.await;

    say(&format!(
        "sayHello, nameless again: {}",
        refusal_of(refused)?
    ))?;

    client
        .disconnect(&TransportClientDisconnectOptions::default())
        .map_err(|error| error.to_string())?
        .await;

    Ok(())
}
