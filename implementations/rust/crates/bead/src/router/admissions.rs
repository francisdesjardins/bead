//! The admissions Bead gives (spec 13.5, 14.3): `require_session`, `require_credential` and
//! `share_leg_b_session`, each named, as an access it refuses tells (spec 13.12).

use core::fmt;
use std::sync::Arc;

use crate::constants::{CredentialScheme, ProtocolCode, RouterSide};
use crate::envelope::Credential;
use crate::errors::ResolverError;
use crate::failure::Failure;
use crate::router::core::{AdmissionRefusal, AdmissionRequest, AdmitFn, handed_header_of};

/// A `before_request`: whether a request may reach its procedure, on its connection, its header and
/// its call's session, never a bearer credential; and the failure it refuses with.
#[derive(Clone)]
pub struct BeforeRequest {
    admits: Arc<dyn Fn(&AdmissionRequest) -> bool + Send + Sync>,
    refusal: Option<Failure>,
    name: Option<&'static str>,
}

impl fmt::Debug for BeforeRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("BeforeRequest")
            .field("name", &self.name)
            .finish_non_exhaustive()
    }
}

impl BeforeRequest {
    /// An admission of the application's: `admits` lets a request through, and a request it
    /// refuses is answered `refusal`, `ACCESS_DENIED` when none.
    #[must_use]
    pub fn new<A: Fn(&AdmissionRequest) -> bool + Send + Sync + 'static>(
        admits: A,
        refusal: Option<Failure>,
    ) -> Self {
        Self {
            admits: Arc::new(admits),
            refusal,
            name: None,
        }
    }

    /// The failure it refuses with.
    #[must_use]
    pub fn refusal(&self) -> Option<&Failure> {
        self.refusal.as_ref()
    }

    /// The admission the router asks of a request: only `true` admits, and its refusal, or
    /// `ACCESS_DENIED` of `side`, refuses.
    pub(crate) fn admission(&self, side: RouterSide) -> AdmitFn {
        let admits = Arc::clone(&self.admits);
        let refusal = self
            .refusal
            .clone()
            .unwrap_or_else(|| Failure::protocol(ProtocolCode::ACCESS_DENIED, side));
        let name = self.name;

        Arc::new(
            move |request: &AdmissionRequest| -> Result<Option<AdmissionRefusal>, ResolverError> {
                let handed = AdmissionRequest {
                    header: handed_header_of(&request.header),
                    ..request.clone()
                };

                // ! an admission that panics refuses as one that fails: answered PROCEDURE_FAILED,
                // reported, the router going on
                match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| admits(&handed))) {
                    Ok(true) => return Ok(None),
                    Ok(false) => {}
                    Err(panicked) => {
                        return Err(ResolverError::Other(Box::new(
                            crate::transport::panicked_of(("an admission", &*panicked)),
                        )));
                    }
                }

                Ok(Some(AdmissionRefusal {
                    failure: refusal.clone(),
                    by: name.map(str::to_owned),
                }))
            },
        )
    }
}

/// A `before_request`, or a relay's `before_route`, that lets through only a call with a session,
/// its call's (spec 13.5), refusing with `SESSION_REQUIRED`.
#[must_use]
pub fn require_session() -> BeforeRequest {
    BeforeRequest {
        admits: Arc::new(|request: &AdmissionRequest| request.session.is_some()),
        refusal: Some(Failure::protocol(
            ProtocolCode::SESSION_REQUIRED,
            RouterSide::Server,
        )),
        name: Some("requireSession"),
    }
}

fn presents_forwarded(request: &AdmissionRequest) -> bool {
    matches!(
        request.header.credential.as_ref().map(Credential::scheme),
        Some(CredentialScheme::JWT | CredentialScheme::ELSEWHERE)
    )
}

/// A server's relay's admission by default (spec 14.3, step 1).
///
/// A call whose header presents a `JWT`, or an `ELSEWHERE` its transport carried, which the relay
/// forwards for its destination to verify; any other refused `ACCESS_DENIED`.
#[must_use]
pub fn require_credential() -> BeforeRequest {
    BeforeRequest {
        admits: Arc::new(presents_forwarded),
        refusal: Some(
            Failure::protocol(ProtocolCode::ACCESS_DENIED, RouterSide::Server)
                .saying("a relay admits by default only a credential it forwards"),
        ),
        name: Some("requireCredential"),
    }
}

/// A relay's `before_route` that lends leg B's session to every session of leg A's (spec 14.3,
/// step 1): a call in a session, or one presenting a credential it forwards; any other refused
/// `SESSION_REQUIRED`.
#[must_use]
pub fn share_leg_b_session() -> BeforeRequest {
    BeforeRequest {
        admits: Arc::new(|request: &AdmissionRequest| {
            request.session.is_some() || presents_forwarded(request)
        }),
        refusal: Some(Failure::protocol(
            ProtocolCode::SESSION_REQUIRED,
            RouterSide::Server,
        )),
        name: Some("shareLegBSession"),
    }
}
