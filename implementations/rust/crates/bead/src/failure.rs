//! A failure, as a router raises it or receives it: whose code it is, the code, why, and — deduced,
//! never sent — which side raised it and where (spec 7, 8.1).

use core::fmt;
use core::num::NonZeroU16;
use std::error::Error;
use std::sync::Arc;

use crate::constants::{FailureScope, ProtocolCode, RouterSide};
use crate::envelope::{FailureRecord, Header};

/// Where a failure comes from: raised here, received from the peer, or received through a relay.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[non_exhaustive]
pub enum FailureOrigin {
    /// Raised by this side.
    Local,
    /// Raised by the peer, through no relay.
    Peer,
    /// Received through a relay, whose side raised it is not known.
    Relayed,
}

/// A procedure, by its service and its own number in that service.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct ProcedureAddress {
    /// Its service's id, from 1 to 65535.
    pub service_id: u16,
    /// Its id in its service, from 1 to 65535.
    pub procedure_id: u16,
}

/// A failure: whose code it is, the code, why, and, deduced, which side raised it and where.
///
/// Raised here, it is [`FailureOrigin::Local`], of this router's side; received through no
/// relay, the peer's; received through a relay, of no known side.
#[derive(Debug, Clone)]
pub struct Failure {
    code: NonZeroU16,
    scope: FailureScope,
    detail: String,
    origin: FailureOrigin,
    relays: u8,
    side: Option<RouterSide>,
    procedure: Option<ProcedureAddress>,
    destination_id: Option<u32>,
    may_overtake: bool,
    header: Option<Box<Header>>,
    source: Option<Arc<dyn Error + Send + Sync>>,
}

impl Failure {
    /// One of the protocol's failures, raised by a router of `side`, its detail empty.
    #[must_use]
    pub fn protocol(code: ProtocolCode, side: RouterSide) -> Self {
        Self::local(code.get(), (FailureScope::Protocol, Some(side)))
    }

    /// A procedure's own failure, of `code`, saying `detail`: what a resolver answers with.
    #[must_use]
    pub fn application(code: NonZeroU16, detail: &str) -> Self {
        let mut failure = Self::local(code, (FailureScope::Application, None));

        detail.clone_into(&mut failure.detail);

        failure
    }

    // a failure raised here
    fn local(code: NonZeroU16, (scope, side): (FailureScope, Option<RouterSide>)) -> Self {
        Self {
            code,
            scope,
            detail: String::new(),
            origin: FailureOrigin::Local,
            relays: 0,
            side,
            procedure: None,
            destination_id: None,
            may_overtake: false,
            header: None,
            source: None,
        }
    }

    /// The failure a record received by a router of `side` stands for: through no relay, the
    /// peer's, of the other side; through a relay, of no known side.
    #[must_use]
    pub fn received(record: &FailureRecord, side: RouterSide) -> Self {
        let is_relayed = record.relays > 0;

        Self {
            code: record.code,
            scope: record.scope,
            detail: record.detail.clone(),
            origin: if is_relayed {
                FailureOrigin::Relayed
            } else {
                FailureOrigin::Peer
            },
            relays: record.relays,
            side: if is_relayed { None } else { Some(side.peer()) },
            procedure: None,
            destination_id: None,
            may_overtake: false,
            header: None,
            source: None,
        }
    }

    /// The same failure, saying `detail`.
    #[must_use]
    pub fn saying<D: Into<String>>(mut self, detail: D) -> Self {
        self.detail = detail.into();
        self
    }

    /// The same failure, about the envelope `header` said, kept without its credential.
    #[must_use]
    pub fn about(mut self, header: &Header) -> Self {
        self.header = Some(Box::new(header.redacted()));
        self
    }

    /// The same failure, of the call to `procedure`, behind `destination_id` when given.
    #[must_use]
    pub fn of_call(
        mut self,
        procedure: Option<ProcedureAddress>,
        destination_id: Option<u32>,
    ) -> Self {
        self.procedure = procedure;
        self.destination_id = destination_id;
        self
    }

    /// The same failure, come by a way that keeps no order with its call's own answer.
    #[must_use]
    pub fn overtaking(mut self, may_overtake: bool) -> Self {
        self.may_overtake = may_overtake;
        self
    }

    /// The same failure, caused by `source`.
    #[must_use]
    pub fn caused_by(mut self, source: Arc<dyn Error + Send + Sync>) -> Self {
        self.source = Some(source);
        self
    }

    /// Its code, the protocol's or the procedure's own.
    #[must_use]
    pub fn code(&self) -> NonZeroU16 {
        self.code
    }

    /// Whose code it is.
    #[must_use]
    pub fn scope(&self) -> FailureScope {
        self.scope
    }

    /// Why, in its raiser's words; empty when it says nothing.
    #[must_use]
    pub fn detail(&self) -> &str {
        &self.detail
    }

    /// Where it comes from.
    #[must_use]
    pub fn origin(&self) -> FailureOrigin {
        self.origin
    }

    /// The relays it crossed: 0 when the peer raised it.
    #[must_use]
    pub fn relays(&self) -> u8 {
        self.relays
    }

    /// The side that raised it, when known.
    #[must_use]
    pub fn side(&self) -> Option<RouterSide> {
        self.side
    }

    /// The procedure the call asked for, which a failure envelope does not repeat.
    #[must_use]
    pub fn procedure(&self) -> Option<ProcedureAddress> {
        self.procedure
    }

    /// What the call went to behind the peer, as the call named it.
    #[must_use]
    pub fn destination_id(&self) -> Option<u32> {
        self.destination_id
    }

    /// Whether it came by a way that keeps no order with the call's own answer, which it may
    /// overtake: over HTTP, a listen's batch (spec 15.9).
    #[must_use]
    pub fn may_overtake(&self) -> bool {
        self.may_overtake
    }

    /// The envelope that said it, without its credential; none for one raised before any envelope.
    #[must_use]
    pub fn header(&self) -> Option<&Header> {
        self.header.as_deref()
    }

    /// Whether this is the protocol's own failure.
    #[must_use]
    pub fn is_protocol(&self) -> bool {
        self.scope == FailureScope::Protocol
    }

    /// Whether this is one of the protocol's `codes`.
    #[must_use]
    pub fn is_protocol_code(&self, codes: &[ProtocolCode]) -> bool {
        self.scope == FailureScope::Protocol && codes.iter().any(|code| code.get() == self.code)
    }

    /// Whether this is the procedure's own failure.
    #[must_use]
    pub fn is_application(&self) -> bool {
        self.scope == FailureScope::Application
    }

    /// Its code as the protocol's, for a failure of the protocol's scope.
    #[must_use]
    pub fn protocol_code(&self) -> Option<ProtocolCode> {
        (self.scope == FailureScope::Protocol).then(|| ProtocolCode::new(self.code))
    }

    /// Its record, as an envelope writes it: its code, its relays, its scope and its detail.
    #[must_use]
    pub fn record(&self) -> FailureRecord {
        FailureRecord {
            code: self.code,
            scope: self.scope,
            detail: self.detail.clone(),
            relays: self.relays,
        }
    }
}

impl fmt::Display for Failure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        if self.origin == FailureOrigin::Local {
            formatter.write_str("local ")?;
        }

        match self.side {
            Some(side) => write!(formatter, "{side}")?,
            None => formatter.write_str("unknown side")?,
        }

        let is_protocol = self.scope == FailureScope::Protocol;

        write!(
            formatter,
            " {} failure {}",
            if is_protocol {
                "protocol"
            } else {
                "application"
            },
            self.code
        )?;

        if let Some(name) = self.protocol_code().and_then(ProtocolCode::name) {
            write!(formatter, " {name}")?;
        }

        if let (false, Some(procedure)) = (is_protocol, self.procedure) {
            write!(
                formatter,
                " (service {}, procedure {})",
                procedure.service_id, procedure.procedure_id
            )?;
        }

        if self.relays > 0 {
            write!(
                formatter,
                ", through {} {}",
                self.relays,
                if self.relays == 1 { "relay" } else { "relays" }
            )?;
        }

        if !self.detail.is_empty() {
            write!(formatter, ": {}", self.detail)?;
        }

        Ok(())
    }
}

impl Error for Failure {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        self.source.as_deref().map(|source| {
            let source: &(dyn Error + 'static) = source;
            source
        })
    }
}
