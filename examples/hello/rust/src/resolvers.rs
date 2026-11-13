//! `HelloService`'s resolvers and its hook, as the Rust side answers them: the only code its server
//! writes, beside the generated `HelloServer`.

use std::collections::BTreeSet;
use std::io::{self, Write};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use bead::{
    AdmissionHook, CommandOptions, ConnectionHandle, NotifyOptions, ProgrammerError, ResolverError,
    RouterError, Server, ServerListener, Subscriber, TransportServerRefusal,
};

use crate::generated::messages::hello::v1::{
    AskNameRequest, CountDownResponse, SayHelloResponse, Tick,
};
use crate::generated::services::hello::v1::{
    HelloAdmissions, HelloFailures, HelloServer, HelloServerOptions,
};

// what sayHello asks a caller that gave no name
const QUESTION: &str = "What is your name?";

// the connections sayHello greeted, each until it closes
type Greeted = Arc<Mutex<BTreeSet<ConnectionHandle>>>;

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

// what the server's transport tells: a connection closed, forgotten by the hook; what went wrong on
// a socket or in a listener, and each request it refused of its own, which no router forwards, on
// the standard error, as the C# server writes them
struct Watching {
    greeted: Greeted,
}

impl ServerListener for Watching {
    fn on_close(&self, _was_clean: bool, connection_handle: &ConnectionHandle) {
        locked(&self.greeted).remove(connection_handle);
    }

    fn on_refusal(&self, refusal: &TransportServerRefusal) {
        writeln!(
            io::stderr().lock(),
            "refused {} {}",
            refusal.status,
            refusal.reason
        )
        .ok();
    }

    fn on_error(&self, error: &RouterError, connection_handle: Option<&ConnectionHandle>) {
        let handle = connection_handle.map_or("no connection", |handle| &**handle);

        writeln!(io::stderr().lock(), "{handle}: {error}").ok();
    }
}

/// `HelloService`, offered on `server`: `sayHello` greets a name, asking its caller's by `askName`
/// when it is given none; `countDown` answers the ticks it will notify, then notifies them to its
/// caller's connection alone, and admits a connection that `sayHello` greeted. A count past 10
/// never reaches it: its request's rule refuses it first.
///
/// # Errors
///
/// A [`ProgrammerError`] its service layer refuses the service with.
pub(crate) fn offer_hello(server: &Server) -> Result<HelloServer, ProgrammerError> {
    let greeted: Greeted = Arc::new(Mutex::new(BTreeSet::new()));
    let admitted = Arc::clone(&greeted);
    let hello = HelloServer::new(&HelloServerOptions::new(HelloAdmissions {
        greeted: AdmissionHook {
            admits: Arc::new(move |request| locked(&admitted).contains(&request.connection_handle)),
            detail: Some("say hello first".to_owned()),
        },
    }))?;

    server.transport().listen(Arc::new(Watching {
        greeted: Arc::clone(&greeted),
    }));

    let ask_name = hello.command().ask_name.clone();

    hello.on_say_hello(move |request, response| {
        let greeted = Arc::clone(&greeted);
        let ask_name = ask_name.clone();

        async move {
            let connection_handle = request.connection_handle;
            let name = if request.payload.name.is_empty() {
                let asking = AskNameRequest {
                    question: QUESTION.to_owned(),
                    ..AskNameRequest::default()
                };

                ask_name
                    .call(asking, &CommandOptions::new(Arc::clone(&connection_handle)))
                    .map_err(ResolverError::other)?
                    .await
                    .map_err(ResolverError::other)?
                    .name
            } else {
                request.payload.name
            };

            if name.is_empty() {
                return response
                    .failure(&HelloFailures::NAMELESS.of("nobody to greet"))
                    .await;
            }

            locked(&greeted).insert(connection_handle);

            response
                .result(SayHelloResponse {
                    greeting: format!("Hello, {name}!"),
                    ..SayHelloResponse::default()
                })
                .await
        }
    })?;

    let count_down = hello.notify().count_down.clone();

    hello.on_count_down(move |request, response| {
        let count_down = count_down.clone();

        async move {
            let connection_handle = request.connection_handle;
            let from = request.payload.from;

            response
                .result(CountDownResponse {
                    ticks: from.saturating_add(1),
                    ..CountDownResponse::default()
                })
                .await?;

            for remaining in (0..=from).rev() {
                let caller = Arc::clone(&connection_handle);
                let mut options = NotifyOptions::default();

                options.filter = Some(Arc::new(move |subscriber: &Subscriber| {
                    subscriber.connection_handle == caller
                }));

                count_down
                    .notify(
                        Tick {
                            remaining,
                            ..Tick::default()
                        },
                        &options,
                    )
                    .await;
            }

            Ok(())
        }
    })?;

    hello.offer(server)?;

    Ok(hello)
}
