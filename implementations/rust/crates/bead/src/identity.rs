//! What a side holds a procedure's identity to as it is declared (spec 16): its ids and its
//! revision in their ranges, its name in its form, its kind one its way takes, and when two names
//! are one.

use core::fmt;

use crate::constants::ProcedureKind;
use crate::errors::{ProgrammerError, Refusal};
use crate::failure::ProcedureAddress;

#[cfg(test)]
mod tests;

/// Why a declaration is refused, by spec 16.10, in the order a side checks them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[non_exhaustive]
pub enum IdentityRefusal {
    /// A service id or a procedure id not from 1 to 65535, or a revision not from 1 to 2³¹ − 1.
    OutOfItsRange,
    /// A name no procedure's name is (spec 16.4).
    OffItsForm,
    /// A kind its way does not take (spec 16.11).
    AgainstItsKind,
}

impl IdentityRefusal {
    /// The reason as `spec/identities.json` derives it.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::OutOfItsRange => "out of its range",
            Self::OffItsForm => "off its form",
            Self::AgainstItsKind => "against its kind",
        }
    }
}

impl fmt::Display for IdentityRefusal {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

/// A way a side declares a procedure, by `spec/identities.json`'s ids (spec 16.11).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[non_exhaustive]
pub enum DeclarationWay {
    /// A resolver registered on a client's router: a command.
    ClientResolver,
    /// A resolver registered on a server's router that notifies nothing: a request.
    ServerResolver,
    /// A resolver registered on a server's router that notifies: a request that notifies.
    ServerNotificationResolver,
    /// A requester made on a client's router: a request, or one that notifies.
    ClientRequester,
    /// A requester made on a server's router: a command.
    ServerRequester,
    /// A notification registered on a client's router: a request that notifies.
    ClientNotification,
}

impl DeclarationWay {
    // the kinds the way takes, and the way in a refusal's words, the C# side's
    fn takes(self) -> (&'static [ProcedureKind], &'static str) {
        match self {
            Self::ClientNotification => (
                &[ProcedureKind::Notifies],
                "a notification on a client's router",
            ),
            Self::ClientRequester => (
                &[ProcedureKind::Request, ProcedureKind::Notifies],
                "a requester on a client's router",
            ),
            Self::ClientResolver => (&[ProcedureKind::Command], "a resolver on a client's router"),
            Self::ServerNotificationResolver => (
                &[ProcedureKind::Notifies],
                "a resolver on a server's router that notifies",
            ),
            Self::ServerRequester => (
                &[ProcedureKind::Command],
                "a requester on a server's router",
            ),
            Self::ServerResolver => (
                &[ProcedureKind::Request],
                "a resolver on a server's router that notifies nothing",
            ),
        }
    }
}

/// One procedure of one service, which names what is made for it (spec 16).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Procedure {
    /// Its service's id, from 1 to 65535 (spec 16.2).
    pub service_id: u16,
    /// Its id in its service, from 1 to 65535 (spec 16.2).
    pub id: u16,
    /// Which revision of its service it is, from 1 to 2³¹ − 1 (spec 16.2, 16.9); it does not
    /// travel.
    pub service_revision: u32,
    /// Its name, which labels what a side traces and counts and never travels (spec 16.4).
    pub name: String,
    /// Its kind, which each router holds its declaration to; none given, nothing checks it.
    pub kind: Option<ProcedureKind>,
    /// The bytes a payload of it holds at most, its request's and its result's, whole or as a
    /// transfer; the router's alone when none.
    pub maximum_payload_bytes: Option<u64>,
    /// Present when it is on its way out: a requester tells `deprecated` at each call.
    pub deprecation: Option<Deprecation>,
}

/// A procedure on its way out, and what to use instead, when it says.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Deprecation {
    /// What to use instead, when it says.
    pub message: Option<String>,
}

impl Procedure {
    /// Its address: its service and its own number in that service.
    #[must_use]
    pub fn address(&self) -> ProcedureAddress {
        ProcedureAddress {
            service_id: self.service_id,
            procedure_id: self.id,
        }
    }
}

// the bounds of 16.2: an id on its 2 bytes, 0 the protocol's (16.3); a revision from 1 to 2³¹ − 1
const LARGEST_REVISION: u32 = 0x7fff_ffff;
const LONGEST_NAME: usize = 63;

/// Whether `name` is a procedure's name (spec 16.4): 1 to 63 characters of ASCII, a lower-case
/// letter and then letters and digits, read a character at a time, never by a case mapping.
#[must_use]
pub fn is_procedure_name(name: &str) -> bool {
    let bytes = name.as_bytes();

    match bytes.split_first() {
        Some((first, rest)) if bytes.len() <= LONGEST_NAME => {
            first.is_ascii_lowercase() && rest.iter().all(u8::is_ascii_alphanumeric)
        }
        Some(_) | None => false,
    }
}

/// Whether `one` and `other` are one name (spec 16.6): equal once each ASCII upper-case letter is
/// read as its lower-case one, and nothing else changed — `café` and `cafÉ` stay two.
#[must_use]
pub fn are_one_name(one: &str, other: &str) -> bool {
    one.len() == other.len()
        && one
            .bytes()
            .zip(other.bytes())
            .all(|(first, second)| first.eq_ignore_ascii_case(&second))
}

/// Refuses a declaration of `procedure` off spec section 16 — its ids or its revision out of their
/// range, then its name off its form — before any reason of the router's own.
///
/// # Errors
///
/// A [`ProgrammerError`] whose reason is the first of 16.10 that applies.
pub fn check_declaration(procedure: &Procedure) -> Result<(), ProgrammerError> {
    let Procedure {
        service_id,
        id: procedure_id,
        service_revision,
        name: procedure_name,
        ..
    } = procedure;

    if *service_id == 0
        || *procedure_id == 0
        || *service_revision == 0
        || *service_revision > LARGEST_REVISION
    {
        return Err(ProgrammerError::refused(
            Refusal::Identity(IdentityRefusal::OutOfItsRange),
            format!(
                "\"{procedure_name}\" at {service_id}/{procedure_id}, revision {service_revision}, is {}: a service and a procedure are from 1 to 65535, a revision from 1 to 2147483647 (spec 16.2)",
                IdentityRefusal::OutOfItsRange
            ),
        ));
    }

    if !is_procedure_name(procedure_name) {
        return Err(ProgrammerError::refused(
            Refusal::Identity(IdentityRefusal::OffItsForm),
            format!(
                "\"{procedure_name}\" at {service_id}/{procedure_id} is {}: a procedure's name is a lower-case ASCII letter, then up to 62 ASCII letters or digits (spec 16.4)",
                IdentityRefusal::OffItsForm
            ),
        ));
    }

    Ok(())
}

// how a refusal names a procedure's kind
fn words_of(kind: ProcedureKind) -> &'static str {
    match kind {
        ProcedureKind::Command => "a command",
        ProcedureKind::Notifies => "a request that notifies",
        ProcedureKind::Request => "a request",
    }
}

/// Refuses a declaration of `procedure` by `way` whose kind that way does not take (spec 16.11). A
/// procedure that states no kind is taken every way. Run after [`check_declaration`].
///
/// # Errors
///
/// A [`ProgrammerError`] whose reason is [`IdentityRefusal::AgainstItsKind`].
pub fn check_procedure_kind(
    procedure: &Procedure,
    way: DeclarationWay,
) -> Result<(), ProgrammerError> {
    let (takes, named) = way.takes();
    let Some(kind) = procedure.kind else {
        return Ok(());
    };

    if takes.contains(&kind) {
        return Ok(());
    }

    Err(ProgrammerError::refused(
        Refusal::Identity(IdentityRefusal::AgainstItsKind),
        format!(
            "\"{}\" at {}/{} is {}: {}, which {named} does not take; it takes {} (spec 16.11)",
            procedure.name,
            procedure.service_id,
            procedure.id,
            IdentityRefusal::AgainstItsKind,
            words_of(kind),
            takes
                .iter()
                .map(|&taken| words_of(taken))
                .collect::<Vec<_>>()
                .join(", or ")
        ),
    ))
}
