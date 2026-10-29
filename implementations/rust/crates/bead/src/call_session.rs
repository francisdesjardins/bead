//! A call's session and its credential (spec 13.1, 13.4): the connection's session a request runs
//! in, the credential a call presents, and the credential its transport cannot carry.

use core::fmt;

use serde_json::Value;

use crate::constants::{CredentialScheme, ProtocolCode, RouterSide};
use crate::envelope::Credential;
use crate::errors::{CallError, ProgrammerError};
use crate::failure::Failure;
use crate::router::types::{CallSession, RequestCredential, carried_or_none};
use crate::session_token::SessionToken;

#[cfg(test)]
mod tests;

/// The connection's session a request presenting `credential` runs in.
///
/// One presenting none runs in it whenever there is one; one presenting `OPAQUE`, when it is that
/// token, compared in constant time; none for any other.
#[must_use]
pub fn connection_session_of(
    credential: Option<&Credential>,
    (token, data): (Option<&SessionToken>, Option<Value>),
) -> Option<CallSession> {
    let token = token?;

    if let Some(credential) = credential {
        let is_its_token = match credential {
            Credential::Opaque(presented) => token.is(presented),
            Credential::None
            | Credential::Jwt(_)
            | Credential::Elsewhere
            | Credential::ToCome { .. } => false,
        };

        if !is_its_token {
            return None;
        }
    }

    Some(CallSession {
        data,
        end: None,
        identifier: None,
    })
}

/// What a call presents, and what its transport carries beside it.
#[derive(Clone, Default, PartialEq, Eq)]
#[non_exhaustive]
pub struct Presented {
    /// The credential its header presents.
    pub credential: Option<Credential>,
    /// What its transport carries beside it, which an `ELSEWHERE` stands for.
    pub carried: Option<String>,
}

impl fmt::Debug for Presented {
    // ! its credential by its scheme, and whether its transport carried one, never what
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("Presented")
            .field("credential", &self.credential)
            .field(
                "carried",
                &format_args!("{}", carried_or_none(self.carried.as_ref())),
            )
            .finish()
    }
}

/// What a call presenting `requested` presents: `OPAQUE`, the session its router learned; a `JWT`,
/// or an `ELSEWHERE` with what its transport carries beside it.
///
/// # Errors
///
/// A [`CallError`]: a failure of `side`'s, `SESSION_REQUIRED`, for `OPAQUE` with no session known,
/// which refuses the call once it started; refused for a `JWT` of no token.
pub fn presented_credential_of(
    requested: Option<&RequestCredential>,
    (side, token): (RouterSide, Option<&SessionToken>),
) -> Result<Presented, CallError> {
    match requested {
        None | Some(RequestCredential::None) => Ok(Presented::default()),
        Some(RequestCredential::Opaque) => token.map_or_else(
            || {
                Err(CallError::Failure(
                    Failure::protocol(ProtocolCode::SESSION_REQUIRED, side)
                        .saying("no session is known for OPAQUE to stand for"),
                ))
            },
            |token| {
                Ok(Presented {
                    credential: Some(Credential::Opaque(*token)),
                    carried: None,
                })
            },
        ),
        Some(RequestCredential::Jwt(token)) => {
            if token.is_empty() {
                return Err(CallError::Refused(ProgrammerError::new(
                    "a call that presents a JWT gives its token, a string",
                )));
            }

            Ok(Presented {
                credential: Some(Credential::Jwt(bytes::Bytes::copy_from_slice(
                    token.as_bytes(),
                ))),
                carried: None,
            })
        }
        Some(RequestCredential::Elsewhere(carried)) => Ok(Presented {
            credential: Some(Credential::Elsewhere),
            carried: Some(carried.clone()),
        }),
    }
}

/// What a call's transport carries beside it: what it was given, whether it takes a credential,
/// whether it stays off the machine's clear; and the side whose failure refuses it.
#[derive(Clone, Copy)]
pub struct Carriage<'carriage> {
    /// What its transport carries beside it, which an `ELSEWHERE` stands for.
    pub carried: Option<&'carriage str>,
    /// Whether its transport takes that credential beside an envelope.
    pub takes: &'carriage dyn Fn(&str) -> bool,
    /// The side that refuses it.
    pub side: RouterSide,
    /// Whether its transport stays off the machine's clear.
    pub is_secure: bool,
}

impl fmt::Debug for Carriage<'_> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("Carriage")
            .field("side", &self.side)
            .field("is_secure", &self.is_secure)
            .finish_non_exhaustive()
    }
}

/// The failure of a call presenting a credential its transport cannot carry (spec 13.4).
///
/// An `ELSEWHERE` whose transport does not carry what it stands for, or a bearer credential over a
/// transport that leaves the machine in the clear.
#[must_use]
pub fn uncarried_of(credential: Option<&Credential>, carriage: &Carriage<'_>) -> Option<Failure> {
    let Carriage {
        carried,
        takes,
        side,
        is_secure,
    } = *carriage;
    let scheme = credential.map(Credential::scheme)?;

    if scheme != CredentialScheme::JWT && scheme != CredentialScheme::ELSEWHERE {
        return None;
    }

    let unreachable = |detail: &str| {
        Failure::protocol(ProtocolCode::DESTINATION_UNREACHABLE, side).saying(detail)
    };

    if scheme == CredentialScheme::ELSEWHERE && carried.is_none_or(|carried| !takes(carried)) {
        return Some(unreachable(
            "its transport does not carry the credential ELSEWHERE stands for beside an envelope: none, or another",
        ));
    }

    (!is_secure).then(|| {
        unreachable("its transport leaves the machine in the clear, which a bearer credential never crosses")
    })
}
