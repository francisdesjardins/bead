//! An exchange of one envelope on an HTTP transport server (spec 15.6), as the other sides'
//! `http-request-exchange.ts` and `HttpTransportServer.RequestExchange` hold one: its body read into
//! one buffer under its bound and its rate, its prefix judged from its first 8 bytes, and its
//! answer written by whatever ends it — a refusal, a 204, the head that says its router has it,
//! the answer its router sends, or its socket cut.

use std::sync::Arc;
use std::sync::atomic::AtomicBool;

use bytes::Bytes;
use hyper::Response;
use tokio::sync::{mpsc, oneshot};

use crate::clock::Timer;
use crate::http::fields::{
    BEAD_BATCH_MEDIA_TYPE, BEAD_MEDIA_TYPE, ENVELOPE_PREFIX_BYTES, End, REFUSAL_HEADER,
    RESPONSE_FIELDS, SEQUENCE_HEADER,
};
use crate::http::wire::{AnswerBody, Closed, Flow, Piece, piece_of, response_of};
use crate::router::types::ConnectionHandle;
use crate::transport::TransportServerRefusal;

#[cfg(test)]
mod tests;

/// What a body is first given room for, before it grows.
const FIRST_BODY_BYTES: usize = 65_536;

/// What an envelope's prefix says the transport needs: its layout, its kind and its call id.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Prefix {
    pub(crate) layout: u8,
    pub(crate) kind: u8,
    pub(crate) call_id: u32,
}

impl Prefix {
    /// What the first 8 bytes of `bytes` say, once they came.
    pub(crate) fn of(bytes: &[u8]) -> Option<Self> {
        let head = bytes.get(..ENVELOPE_PREFIX_BYTES)?;
        let call_id: [u8; 4] = head.get(4..8)?.try_into().ok()?;

        Some(Self {
            layout: *head.first()?,
            kind: *head.get(1)?,
            call_id: u32::from_be_bytes(call_id),
        })
    }
}

/// A body as it comes: one buffer it grows into, up to its bound, so no piece it came in is kept.
#[derive(Debug, Default)]
pub(crate) struct BodyBuffer {
    bytes: Vec<u8>,
}

impl BodyBuffer {
    /// A buffer given room for what `declared` says, up to its first room.
    pub(crate) fn new(declared: Option<u64>) -> Self {
        let room = declared
            .and_then(|declared| usize::try_from(declared).ok())
            .map_or(FIRST_BODY_BYTES, |declared| declared.min(FIRST_BODY_BYTES));

        Self {
            bytes: Vec::with_capacity(room),
        }
    }

    /// `piece` copied in, the room doubling as it needs, up to `limit`.
    pub(crate) fn append(&mut self, (piece, limit): (&[u8], usize)) {
        let length = self.bytes.len().saturating_add(piece.len());

        if length > self.bytes.capacity() {
            let room = length
                .max(self.bytes.capacity().saturating_mul(2))
                .min(limit);

            self.bytes
                .reserve_exact(room.saturating_sub(self.bytes.len()));
        }

        self.bytes.extend_from_slice(piece);
    }

    /// What came so far.
    pub(crate) fn as_slice(&self) -> &[u8] {
        &self.bytes
    }

    /// What came, whole.
    pub(crate) fn into_bytes(self) -> Bytes {
        Bytes::from(self.bytes)
    }
}

/// What a refusal of an exchange tells of its request (spec 15.1), and how its end is written: its
/// version, and whether it says it has a body.
#[derive(Debug, Clone)]
pub(crate) struct Facts {
    pub(crate) address: Option<String>,
    pub(crate) port: u16,
    pub(crate) authority: Option<String>,
    pub(crate) origin: Option<String>,
    pub(crate) is_http1: bool,
    pub(crate) has_body: bool,
}

impl Facts {
    /// The refusal `end` tells, when it is marked.
    pub(crate) fn refusal_of(&self, end: &End) -> Option<TransportServerRefusal> {
        end.reason.map(|reason| {
            let mut refusal = TransportServerRefusal::new(end.status, reason);

            refusal.address.clone_from(&self.address);
            refusal.authority.clone_from(&self.authority);
            refusal.origin.clone_from(&self.origin);
            refusal.port = Some(self.port);
            refusal
        })
    }
}

/// What writes an exchange's answer, once: its head and body whole, or its head, then its body as
/// it comes; or a cut. Each body it writes tells `closed` whether hyper took it whole.
pub(crate) struct Responder {
    head: Option<oneshot::Sender<Response<AnswerBody>>>,
    body: Option<mpsc::UnboundedSender<Piece>>,
    // the origin `origins` names, which every answer once judged names
    listed: Option<String>,
    closed: Option<Closed>,
    flow: Arc<Flow>,
}

impl Responder {
    /// A responder sending its head on `head`, every answer naming `listed`, its connection's flow
    /// told of its answer.
    pub(crate) fn new(
        head: oneshot::Sender<Response<AnswerBody>>,
        (listed, flow): (Option<String>, Arc<Flow>),
    ) -> Self {
        Self {
            head: Some(head),
            body: None,
            listed,
            closed: None,
            flow,
        }
    }

    /// Itself, its body telling `closed` whether it was taken whole.
    pub(crate) fn telling(mut self, closed: Closed) -> Self {
        self.closed = Some(closed);
        self
    }

    /// Whether its head went.
    pub(crate) const fn is_head_sent(&self) -> bool {
        self.head.is_none()
    }

    /// Its connection's flow.
    pub(crate) fn flow(&self) -> Arc<Flow> {
        Arc::clone(&self.flow)
    }

    /// Answers what HTTP refuses of its own as HTTP answers it: 400, unmarked, with none of the
    /// path's fields, its socket closed.
    pub(crate) fn refuse_malformed(&mut self) {
        if self.head.is_some() {
            let body = self.body_of(AnswerBody::whole(None));

            self.send_head(response_of(
                400,
                (
                    &[
                        ("connection", "close".to_owned()),
                        ("content-length", "0".to_owned()),
                    ],
                    body,
                ),
            ));
        }
    }

    // the fields every answer of the path carries, then `end`'s, its mark, and its origin's
    fn fields_of(&self, end: &End) -> Vec<(&'static str, String)> {
        let mut fields: Vec<(&'static str, String)> = RESPONSE_FIELDS
            .iter()
            .map(|(name, value)| (*name, (*value).to_owned()))
            .collect();

        fields.extend(end.fields.iter().cloned());

        if let Some(reason) = end.reason {
            fields.push((REFUSAL_HEADER, reason.to_owned()));
        }

        if let Some(listed) = &self.listed {
            fields.push(("access-control-allow-origin", listed.clone()));
            fields.push(("access-control-expose-headers", "*".to_owned()));
        }

        fields
    }

    fn body_of(&mut self, body: AnswerBody) -> AnswerBody {
        let body = body.settling(&self.flow);

        match self.closed.take() {
            Some(closed) => body.telling(closed),
            None => body,
        }
    }

    fn send_head(&mut self, response: Response<AnswerBody>) {
        if let Some(head) = self.head.take() {
            self.flow.answer_begun();
            head.send(response).ok();
        }
    }

    /// Writes `end`, once: its status and fields, marked when it is a refusal; past its head, its
    /// body ended.
    pub(crate) fn end(&mut self, end: &End) {
        if self.head.is_some() {
            let fields = self.fields_of(end);
            let body = self.body_of(AnswerBody::whole(None));

            self.send_head(response_of(end.status, (&fields, body)));
        } else if let Some(body) = self.body.take() {
            body.send(Piece::End).ok();
        }
    }

    /// Writes `end` as [`Responder::end`] does, saying `connection: close`: its socket closes in
    /// stages once its connection ends, so what still comes of its body is dropped, never read as
    /// a next request (RFC 9112 §9.6).
    pub(crate) fn end_closing(&mut self, end: &End) {
        self.flow.linger();
        self.end(&end.clone().with(("connection", "close".to_owned())));
    }

    /// Writes the head of a request handed on, a 200 of Bead's type, which says its router has it:
    /// once, before its answer, its body to come.
    pub(crate) fn head(&mut self) {
        if self.head.is_some() {
            let fields =
                self.fields_of(&End::of(200).with(("content-type", BEAD_MEDIA_TYPE.to_owned())));
            let (body, pieces) = AnswerBody::streamed();
            let body = self.body_of(body);

            self.body = Some(pieces);
            self.send_head(response_of(200, (&fields, body)));
        }
    }

    /// Writes `answer`: whole with its head, `closing` its socket when its request's body is not,
    /// or past its head as its body, ended.
    pub(crate) fn answer(&mut self, (answer, closing): (Bytes, bool)) {
        if self.head.is_some() {
            let mut end = End::of(200).with(("content-type", BEAD_MEDIA_TYPE.to_owned()));

            if closing {
                self.flow.linger();
                end = end.with(("connection", "close".to_owned()));
            }

            let fields = self.fields_of(&end);
            let body = self.body_of(AnswerBody::whole(Some(answer)));

            self.send_head(response_of(200, (&fields, body)));
        } else if let Some(body) = self.body.take() {
            let mut rest = Some(answer);

            while let Some(piece) = piece_of(&mut rest) {
                body.send(Piece::Data(piece)).ok();
            }

            body.send(Piece::End).ok();
        }
    }

    /// Writes what a listen brings back: `batch`, each envelope after its length, the first
    /// numbered `first` (spec 15.9).
    pub(crate) fn batch(&mut self, (batch, first): (Bytes, u64)) {
        if self.head.is_some() {
            let fields = self.fields_of(
                &End::of(200)
                    .with(("content-type", BEAD_BATCH_MEDIA_TYPE.to_owned()))
                    .with((SEQUENCE_HEADER, first.to_string())),
            );
            let body = self.body_of(AnswerBody::whole(Some(batch)));

            self.send_head(response_of(200, (&fields, body)));
        }
    }

    /// Cuts it: past its head, its body ends before its end; before, its socket ends with nothing
    /// written.
    pub(crate) fn cut(&mut self) {
        self.head = None;
        self.body = None;
    }
}

/// An exchange of a request, from its first 8 bytes to its answer, as its server holds it.
#[expect(
    clippy::struct_excessive_bools,
    reason = "an exchange's marks, each set apart from the others, as the other sides' exchange holds them"
)]
pub(crate) struct ExchangeState {
    pub(crate) connection: ConnectionHandle,
    pub(crate) facts: Facts,
    pub(crate) responder: Responder,
    /// What its first 8 bytes said, once they came.
    pub(crate) prefix: Option<Prefix>,
    /// A cancel came for it while its body was still coming: it is read to its end, then 204.
    pub(crate) is_cancelled: bool,
    /// Its request went on to the router, which owes it an answer.
    pub(crate) is_delivered: bool,
    /// The transport ended it — an answer, a 204, a refusal, its connection closed — so its close
    /// is no loss.
    pub(crate) is_ended: bool,
    /// Its body came whole.
    pub(crate) is_whole: bool,
    /// Read whole and waiting at its connection's gate: its body stays charged until handed on.
    pub(crate) is_held_back: bool,
    /// What its body holds of the server's budget.
    pub(crate) charged: u64,
    /// What its body brought, counted as it came.
    pub(crate) received: u64,
    /// Its body's pace: the timer its rate is judged by.
    pub(crate) slow: Option<Arc<dyn Timer>>,
    /// Ends its connection, as lost, once its request waited past its timeout for its answer.
    pub(crate) timer: Option<Arc<dyn Timer>>,
    /// Its body read whole, until it is handed on.
    pub(crate) envelope: Option<Bytes>,
    /// The credential its request carries.
    pub(crate) credential: Option<String>,
    /// Whether its answer was taken whole, once one is written, which its pace reads.
    pub(crate) taken: Option<Arc<AtomicBool>>,
    /// What hears whether its answer was taken whole.
    pub(crate) answered: Option<oneshot::Sender<bool>>,
    /// Its request and its response, each until done.
    pub(crate) sides: u8,
}
