//! A gateway's route table, as beadc writes it into an output with a `gateway` (decision 0037,
//! spec/transcoding.md 3): data alone, each procedure's descriptor, payloads and routes, its default
//! ones first, then its rules.

use core::fmt;
use std::sync::Arc;

use crate::errors::ProgrammerError;
use crate::service::{ListedFailure, ServiceProcedure};
use crate::transcoding::form::MessageForm;

#[cfg(test)]
mod tests;

/// The methods a rule's pattern names (transcoding 3.4), `custom` refused by the builder.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[non_exhaustive]
pub enum HttpMethod {
    /// `DELETE`.
    Delete,
    /// `GET`.
    Get,
    /// `PATCH`.
    Patch,
    /// `POST`.
    Post,
    /// `PUT`.
    Put,
}

impl HttpMethod {
    /// The method as HTTP spells it.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Delete => "DELETE",
            Self::Get => "GET",
            Self::Patch => "PATCH",
            Self::Post => "POST",
            Self::Put => "PUT",
        }
    }
}

impl fmt::Display for HttpMethod {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

/// A payload as a route reads and writes its JSON: a message's form, or an encoding of Bead's.
#[derive(Debug, Clone)]
#[non_exhaustive]
pub enum HttpPayload {
    /// A message, through its JSON form.
    Message(Arc<dyn MessageForm>),
    /// Bead's `json` encoding: its body the payload's JSON text.
    Json,
    /// Bead's `text` encoding: its body the payload's UTF-8 text.
    Text,
    /// Bead's `raw` encoding: its body the payload's bytes.
    Raw,
}

impl HttpPayload {
    /// The message's form, where it is one.
    #[must_use]
    pub fn form(&self) -> Option<&Arc<dyn MessageForm>> {
        match self {
            Self::Message(form) => Some(form),
            Self::Json | Self::Text | Self::Raw => None,
        }
    }
}

/// One route of a procedure: its method, its template, its body and its response body.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpRouteTemplate {
    /// Its method.
    pub method: HttpMethod,
    /// `http.proto`'s path template, its verb after a `:` where it has one.
    pub template: String,
    /// `*`, its request whole less what its variables bind, or a top-level field's name; none, no
    /// body.
    pub body: Option<String>,
    /// A top-level field of its result, whose JSON is the body it answers (transcoding 5.8).
    pub response_body: Option<String>,
}

/// A procedure a client calls, as its route table holds it, written as a struct literal.
#[derive(Debug, Clone)]
pub struct HttpRouteInit {
    /// Its descriptor, its service's `<Service>Procedures` member.
    pub procedure: ServiceProcedure,
    /// Its request's payload.
    pub request: HttpPayload,
    /// Its result's payload.
    pub result: HttpPayload,
    /// Its notification's payload, for a procedure that notifies.
    pub notification: Option<HttpPayload>,
    /// Its service's catalogue, each failure's name and code.
    pub failures: Vec<ListedFailure>,
    /// Whether its method is marked `NO_SIDE_EFFECTS`.
    pub no_side_effects: bool,
    /// Its routes, its default ones first, then its rules in their order.
    pub routes: Vec<HttpRouteTemplate>,
}

/// A route of the table, as [`route_of`] holds it: read by its accessors.
#[derive(Debug, Clone)]
pub struct HttpRoute {
    init: Arc<HttpRouteInit>,
}

impl HttpRoute {
    /// Its procedure.
    #[must_use]
    pub fn procedure(&self) -> &ServiceProcedure {
        &self.init.procedure
    }

    /// Its request's payload.
    #[must_use]
    pub fn request(&self) -> &HttpPayload {
        &self.init.request
    }

    /// Its result's payload.
    #[must_use]
    pub fn result(&self) -> &HttpPayload {
        &self.init.result
    }

    /// Its notification's payload, where it notifies.
    #[must_use]
    pub fn notification(&self) -> Option<&HttpPayload> {
        self.init.notification.as_ref()
    }

    /// Its service's catalogue.
    #[must_use]
    pub fn failures(&self) -> &[ListedFailure] {
        &self.init.failures
    }

    /// Whether its method is marked `NO_SIDE_EFFECTS`.
    #[must_use]
    pub fn no_side_effects(&self) -> bool {
        self.init.no_side_effects
    }

    /// Its routes, its default ones first, then its rules.
    #[must_use]
    pub fn routes(&self) -> &[HttpRouteTemplate] {
        &self.init.routes
    }
}

/// A route of the table, as beadc writes it.
///
/// A procedure that notifies without its notification's
/// payload, or one that does not with one, or a route of an empty template, is a
/// [`ProgrammerError`]. What a template means is the gateway's to judge, as it reads the table; a
/// payload of no form nor encoding, or a method none of `http.proto`'s patterns names, is no value
/// of its type.
///
/// # Errors
///
/// A [`ProgrammerError`] where the route does not hold.
pub fn route_of(init: HttpRouteInit) -> Result<HttpRoute, ProgrammerError> {
    let name = &init.procedure.procedure().procedure_name;

    if init.procedure.notifies() != init.notification.is_some() {
        return Err(ProgrammerError::new(format!(
            "{name}'s notification is its route's exactly where it notifies"
        )));
    }

    if init.routes.iter().any(|route| route.template.is_empty()) {
        return Err(ProgrammerError::new(format!(
            "{name}'s route is a method of http.proto's and a template"
        )));
    }

    Ok(HttpRoute {
        init: Arc::new(init),
    })
}
