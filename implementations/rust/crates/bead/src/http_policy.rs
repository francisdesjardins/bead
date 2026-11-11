//! What an HTTP server judges a request by first, given once to every listener of an application
//! (spec 15.12, decision 0037).
//!
//! Its HTTP transport and its gateway alike take it, so two listeners never keep two lists alike
//! in silence: the hosts it takes, the origins it answers CORS to, the proxies whose
//! `X-Forwarded-For` it believes, and the bounds spec 15.12 names. Always built, as the other
//! sides' `httpPolicyOf` and `HttpPolicy` are, whatever the transports a build carries.

use core::time::Duration;

use crate::duration::hold_finite;
use crate::errors::ProgrammerError;
use crate::judgement::hosts::{assert_hosts, assert_origins};
use crate::judgement::proxies::trusted_proxies_of;

#[cfg(test)]
mod tests;

/// What an [`HttpPolicy`] is made of: each member the listeners' option of its name, none where it
/// is not given.
#[derive(Debug, Clone, Default)]
#[non_exhaustive]
pub struct HttpPolicyOptions {
    /// As [`HttpPolicy::body_bytes_budget`].
    pub body_bytes_budget: Option<u64>,
    /// As [`HttpPolicy::body_grace_period`].
    pub body_grace_period: Option<Duration>,
    /// As [`HttpPolicy::headers_timeout`].
    pub headers_timeout: Option<Duration>,
    /// As [`HttpPolicy::hosts`].
    pub hosts: Option<Vec<String>>,
    /// As [`HttpPolicy::maximum_body_bytes`].
    pub maximum_body_bytes: Option<u64>,
    /// As [`HttpPolicy::maximum_connections`].
    pub maximum_connections: Option<u64>,
    /// As [`HttpPolicy::maximum_connections_per_address`].
    pub maximum_connections_per_address: Option<u64>,
    /// As [`HttpPolicy::minimum_body_bytes_per_second`].
    pub minimum_body_bytes_per_second: Option<u64>,
    /// As [`HttpPolicy::minimum_send_bytes_per_second`].
    pub minimum_send_bytes_per_second: Option<u64>,
    /// As [`HttpPolicy::origins`].
    pub origins: Option<Vec<String>>,
    /// As [`HttpPolicy::send_grace_period`].
    pub send_grace_period: Option<Duration>,
    /// As [`HttpPolicy::trusted_proxies`].
    pub trusted_proxies: Option<Vec<String>>,
    /// As [`HttpPolicy::unnamed_proxies`].
    pub unnamed_proxies: Option<u64>,
}

/// What an HTTP server judges a request by first: each member the option of its name a listener
/// takes, none where the policy gives none, which leaves the listener's own.
///
/// Built by [`HttpPolicy::of`], checked once as each listener checks its own members, its lists
/// copied.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpPolicy {
    given: HttpPolicyMembers,
}

// a policy's members, as it holds them, each duration held to a whole number of milliseconds
#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct HttpPolicyMembers {
    body_bytes_budget: Option<u64>,
    body_grace_period: Option<Duration>,
    headers_timeout: Option<Duration>,
    hosts: Option<Vec<String>>,
    maximum_body_bytes: Option<u64>,
    maximum_connections: Option<u64>,
    maximum_connections_per_address: Option<u64>,
    minimum_body_bytes_per_second: Option<u64>,
    minimum_send_bytes_per_second: Option<u64>,
    origins: Option<Vec<String>>,
    send_grace_period: Option<Duration>,
    trusted_proxies: Option<Vec<String>>,
    unnamed_proxies: Option<u64>,
}

// a duration held as a listener holds it (spec 1.4), finite
fn held_of(name: &str, duration: Option<Duration>) -> Result<Option<Duration>, ProgrammerError> {
    duration.map(|given| hold_finite(name, given)).transpose()
}

impl HttpPolicy {
    /// A policy of `options`' members, checked once as a listener checks its own.
    ///
    /// # Errors
    ///
    /// A [`ProgrammerError`] naming what does not hold: an entry of its hosts, its origins or its
    /// proxies none takes, an unnamed count past 8, a count of 0, or a duration off its range,
    /// finite.
    pub fn of(options: &HttpPolicyOptions) -> Result<Self, ProgrammerError> {
        assert_hosts(options.hosts.as_deref().unwrap_or_default())?;
        assert_origins(options.origins.as_deref().unwrap_or_default())?;
        trusted_proxies_of(
            options.trusted_proxies.as_deref().unwrap_or_default(),
            options.unnamed_proxies,
        )?;

        for (name, count) in [
            ("bodyBytesBudget", options.body_bytes_budget),
            ("maximumBodyBytes", options.maximum_body_bytes),
            ("maximumConnections", options.maximum_connections),
            (
                "maximumConnectionsPerAddress",
                options.maximum_connections_per_address,
            ),
        ] {
            if count == Some(0) {
                return Err(ProgrammerError::new(format!(
                    "{name} is a whole number above 0, not 0"
                )));
            }
        }

        Ok(Self {
            given: HttpPolicyMembers {
                body_bytes_budget: options.body_bytes_budget,
                body_grace_period: held_of("bodyGracePeriod", options.body_grace_period)?,
                headers_timeout: held_of("headersTimeout", options.headers_timeout)?,
                hosts: options.hosts.clone(),
                maximum_body_bytes: options.maximum_body_bytes,
                maximum_connections: options.maximum_connections,
                maximum_connections_per_address: options.maximum_connections_per_address,
                minimum_body_bytes_per_second: options.minimum_body_bytes_per_second,
                minimum_send_bytes_per_second: options.minimum_send_bytes_per_second,
                origins: options.origins.clone(),
                send_grace_period: held_of("sendGracePeriod", options.send_grace_period)?,
                trusted_proxies: options.trusted_proxies.clone(),
                unnamed_proxies: options.unnamed_proxies,
            },
        })
    }

    /// The bytes of body every request together holds at once.
    #[must_use]
    pub const fn body_bytes_budget(&self) -> Option<u64> {
        self.given.body_bytes_budget
    }

    /// How long a body comes before its rate is held.
    #[must_use]
    pub const fn body_grace_period(&self) -> Option<Duration> {
        self.given.body_grace_period
    }

    /// How long a request's head may take to come whole.
    #[must_use]
    pub const fn headers_timeout(&self) -> Option<Duration> {
        self.given.headers_timeout
    }

    /// The hosts it takes beside the loopbacks' names and IP literals; `*` takes any (spec 15.12).
    #[must_use]
    pub fn hosts(&self) -> Option<&[String]> {
        self.given.hosts.as_deref()
    }

    /// The bytes one request's body holds at most.
    #[must_use]
    pub const fn maximum_body_bytes(&self) -> Option<u64> {
        self.given.maximum_body_bytes
    }

    /// The connections it holds at once.
    #[must_use]
    pub const fn maximum_connections(&self) -> Option<u64> {
        self.given.maximum_connections
    }

    /// The connections one client's address holds at once.
    #[must_use]
    pub const fn maximum_connections_per_address(&self) -> Option<u64> {
        self.given.maximum_connections_per_address
    }

    /// The slowest a request's body may come once its grace passed, in bytes a second; 0 holds
    /// none.
    #[must_use]
    pub const fn minimum_body_bytes_per_second(&self) -> Option<u64> {
        self.given.minimum_body_bytes_per_second
    }

    /// The slowest a socket may take what goes to it once its grace passed, in bytes a second; 0
    /// holds none.
    #[must_use]
    pub const fn minimum_send_bytes_per_second(&self) -> Option<u64> {
        self.given.minimum_send_bytes_per_second
    }

    /// The origins it answers CORS to, beside its own (spec 15.12, decision 0027).
    #[must_use]
    pub fn origins(&self) -> Option<&[String]> {
        self.given.origins.as_deref()
    }

    /// The least time what goes is given to be taken.
    #[must_use]
    pub const fn send_grace_period(&self) -> Option<Duration> {
        self.given.send_grace_period
    }

    /// The proxies whose `X-Forwarded-For` it believes, by address or network (decision 0030).
    #[must_use]
    pub fn trusted_proxies(&self) -> Option<&[String]> {
        self.given.trusted_proxies.as_deref()
    }

    /// How many proxies stand in front of it unnamed, from 0 to 8 (decision 0030).
    #[must_use]
    pub const fn unnamed_proxies(&self) -> Option<u64> {
        self.given.unnamed_proxies
    }
}
