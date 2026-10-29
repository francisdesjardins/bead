//! A core's port, on an owner and a stepping clock: the callbacks a side supplies, its envelopes
//! and reports, and sends a test settles in any order. Kept inside the crate: the core is private.

use core::time::Duration;
use std::collections::{BTreeMap, VecDeque};
use std::sync::{Arc, Mutex};

use bytes::Bytes;
use tokio::sync::oneshot;

use crate::clock::SharedClock;
use crate::constants::RouterSide;
use crate::debug::{DebugDirection, TracedEnvelope};
use crate::envelope::{
    CreditHeader, Envelope, FailureHeader, FailureRecord, Header, NotificationHeader,
};
use crate::errors::CallError;
use crate::owner::Owner;
use crate::router::core::{self as router_core, BeforeAnswer, Core, Dispatch, Side, Undo};
use crate::router::parts::Answering;
use crate::router::requester::{self, CoreRequest};
use crate::router::types::{
    ConnectionHandle, RouterAnswer, RouterError, RouterLimitsOptions, RouterResult, Signal,
    TransportMessage, limits_of,
};
use crate::session_token::SessionToken;
use crate::testing::{SteppingClock, instants, scripted};
use crate::transport::Sent;

pub(crate) type Completion<T> = oneshot::Receiver<Result<T, CallError>>;

#[expect(
    clippy::struct_excessive_bools,
    reason = "a test scripts the four independent capabilities of its port"
)]
pub(crate) struct State {
    pub(crate) core: Core<Self>,
    pub(crate) tokens: BTreeMap<ConnectionHandle, SessionToken>,
    pub(crate) sending: VecDeque<Result<Sent, RouterError>>,
    pub(crate) sent: Vec<(ConnectionHandle, Envelope)>,
    pub(crate) reports: Vec<(ConnectionHandle, RouterError)>,
    pub(crate) before: Vec<BeforeAnswer>,
    pub(crate) before_sent: Vec<usize>,
    pub(crate) undone: Vec<u32>,
    pub(crate) notifications: Vec<(ConnectionHandle, NotificationHeader, Bytes)>,
    pub(crate) credits: Vec<(ConnectionHandle, CreditHeader)>,
    pub(crate) unpaired: Vec<(ConnectionHandle, FailureHeader, FailureRecord)>,
    pub(crate) traces: Vec<(DebugDirection, TracedEnvelope)>,
    pub(crate) activity: Vec<(crate::router::types::RouterActivity, ConnectionHandle)>,
    pub(crate) takes_notifications: bool,
    pub(crate) sends_notifications: bool,
    pub(crate) takes_unpaired: bool,
    pub(crate) two_way: bool,
}

impl core::fmt::Debug for State {
    fn fmt(&self, formatter: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        formatter
            .debug_struct("State")
            .field("core", &self.core)
            .finish_non_exhaustive()
    }
}

impl Side for State {
    fn core(&mut self) -> &mut Core<Self> {
        &mut self.core
    }

    fn is_two_way(&self, _handle: &ConnectionHandle) -> bool {
        self.two_way
    }

    fn before_answer(&mut self, answer: BeforeAnswer) -> Option<Undo<Self>> {
        let call_id = answer.header.call_id;
        self.before_sent.push(self.sent.len());
        self.before.push(answer);
        Some(Box::new(move |state| {
            state.undone.push(call_id);
        }))
    }

    fn takes_notifications(&self) -> bool {
        self.takes_notifications
    }

    fn on_notification(
        &mut self,
        header: NotificationHeader,
        (handle, payload): (&ConnectionHandle, Bytes),
    ) {
        self.notifications
            .push((Arc::clone(handle), header, payload));
    }

    fn sends_notifications(&self) -> bool {
        self.sends_notifications
    }

    fn on_subscription_credit(&mut self, header: &CreditHeader, handle: &ConnectionHandle) {
        self.credits.push((Arc::clone(handle), header.clone()));
    }

    fn on_unpaired_failure(
        &mut self,
        (header, failure): (&FailureHeader, &FailureRecord),
        handle: &ConnectionHandle,
    ) -> bool {
        self.unpaired
            .push((Arc::clone(handle), header.clone(), failure.clone()));
        self.takes_unpaired
    }

    fn is_tracing(&self) -> bool {
        true
    }

    fn activity(
        &mut self,
        activity: crate::router::types::RouterActivity,
        handle: &ConnectionHandle,
    ) {
        self.activity.push((activity, Arc::clone(handle)));
    }

    fn trace(&mut self, direction: DebugDirection, (handle, header): (&ConnectionHandle, &Header)) {
        self.traces
            .push((direction, TracedEnvelope::of(handle, header)));
    }

    fn report(&mut self, error: RouterError, handle: &ConnectionHandle) {
        self.reports.push((Arc::clone(handle), error));
    }

    fn transmit(
        &mut self,
        message: TransportMessage,
        handle: &ConnectionHandle,
    ) -> Result<Sent, RouterError> {
        self.sent.push((
            Arc::clone(handle),
            scripted::envelope_of(&message.data, self.core.side.peer()),
        ));
        self.sending.pop_front().unwrap_or(Ok(Sent::Done))
    }

    fn session_token_of(&mut self, handle: &ConnectionHandle) -> Option<SessionToken> {
        self.tokens.get(handle).copied()
    }
}

/// A core on a port a test scripts, without a client's or server's other policies.
#[derive(Debug)]
pub(crate) struct Peer {
    pub(crate) clock: Arc<SteppingClock>,
    pub(crate) owner: Owner<State>,
}

impl Peer {
    pub(crate) fn new(side: RouterSide, limits: &RouterLimitsOptions) -> Self {
        let clock = SteppingClock::new(instants::new_year());
        let shared: SharedClock = Arc::<SteppingClock>::clone(&clock);
        let runtime = crate::platform::runtime_of(None, "a test's core").expect("a runtime");
        let limits = limits_of(limits).expect("limits that hold");
        let owner = Owner::spawn((&runtime, &shared), |owner| State {
            core: Core::new(owner, (side, limits, Arc::clone(&shared), None)),
            tokens: BTreeMap::new(),
            sending: VecDeque::new(),
            sent: Vec::new(),
            reports: Vec::new(),
            before: Vec::new(),
            before_sent: Vec::new(),
            undone: Vec::new(),
            notifications: Vec::new(),
            credits: Vec::new(),
            unpaired: Vec::new(),
            traces: Vec::new(),
            activity: Vec::new(),
            takes_notifications: false,
            sends_notifications: false,
            takes_unpaired: false,
            two_way: true,
        });
        Self { clock, owner }
    }

    pub(crate) fn send(&self, (envelope, handle): (Envelope, ConnectionHandle)) -> Completion<()> {
        let (reply, answer) = oneshot::channel();
        self.owner.offer(Box::new(move |state| {
            let mut options = router_core::Deliver::to(&handle);
            options.then = Some(Box::new(move |_, outcome| {
                reply.send(outcome).ok();
            }));
            router_core::deliver(state, (envelope, options));
        }));
        answer
    }

    pub(crate) fn respond(
        &self,
        (answer, call): (RouterAnswer, crate::router::types::CallAddress),
    ) -> Completion<()> {
        let (reply, response) = oneshot::channel();
        self.owner.offer(Box::new(move |state| {
            let id = state.core.draw_id();
            let dispatch = Arc::new(Dispatch {
                id,
                connection_handle: Arc::clone(&call.connection_handle),
                header: scripted_header(call.call_id),
                handler: Mutex::new(None),
                session: Mutex::new(None),
                answered: Mutex::new(None),
                origin: (None, None),
            });
            state
                .core
                .answering
                .answering
                .entry(call.connection_handle)
                .or_default()
                .insert(
                    call.call_id,
                    Answering {
                        dispatched: id,
                        signal: Signal::new(),
                        is_answered: false,
                        is_ended: false,
                        receiving: None,
                        series: None,
                        started_at: Duration::ZERO,
                    },
                );
            router_core::respond(
                state,
                (
                    answer,
                    dispatch,
                    Some(Box::new(move |_, outcome| {
                        reply.send(outcome).ok();
                    })),
                ),
            );
        }));
        response
    }

    pub(crate) fn request(
        &self,
        (payload, request): (Bytes, CoreRequest),
    ) -> Completion<RouterResult> {
        let (reply, answer) = oneshot::channel();
        self.owner.offer(Box::new(move |state| {
            requester::request(
                state,
                (
                    payload,
                    request,
                    Box::new(move |outcome| {
                        reply.send(outcome).ok();
                    }),
                ),
            );
        }));
        answer
    }

    pub(crate) fn receive(&self, (envelope, handle): (Envelope, ConnectionHandle)) {
        self.owner.offer(Box::new(move |state| {
            router_core::receive(
                state,
                (
                    TransportMessage {
                        data: scripted::bytes_of(&envelope),
                        ..TransportMessage::default()
                    },
                    &handle,
                ),
            );
        }));
    }

    pub(crate) async fn settle(&self) {
        self.clock.settle().await;
    }

    pub(crate) async fn sent(&self) -> Vec<(ConnectionHandle, Envelope)> {
        self.owner
            .run(|state| state.sent.clone())
            .await
            .expect("the port lives")
    }
}

pub(crate) fn scripted_header(call_id: u32) -> crate::envelope::RequestHeader {
    crate::envelope::RequestHeader {
        call_id,
        service_id: 2,
        procedure_id: 1,
        destination_id: None,
        opens_subscription: false,
        paced: false,
        total: None,
        credential: None,
    }
}

pub(crate) fn request_of(handle: &str) -> CoreRequest {
    CoreRequest {
        connection_handle: Arc::from(handle),
        credential: None,
        on_call_id: None,
        on_sent: None,
        opens_subscription: false,
        paced: false,
        options: crate::router::types::ResolvedRequestOptions {
            timeout: Duration::from_secs(1),
            destination_id: None,
            connection_handle: None,
            credential: None,
            signal: None,
            close_on_timeout: false,
        },
        procedure: crate::testing::pair::echo().address(),
        maximum_payload_bytes: None,
        refusal: None,
        series: None,
        transport_credential: None,
    }
}

pub(crate) fn error_of(message: &str) -> RouterError {
    RouterError::Other(Arc::new(std::io::Error::other(message.to_owned())))
}

pub(crate) async fn completed<T>(answer: Completion<T>) -> Result<T, CallError> {
    crate::testing::patience(Duration::from_secs(10), answer)
        .await
        .expect("the operation settles")
        .expect("the port replies")
}
