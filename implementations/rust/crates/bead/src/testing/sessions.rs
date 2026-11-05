//! A clock that refuses every timer: sessions use NEVER for their timeouts.

use core::time::Duration;
use std::sync::Arc;

use crate::clock::Timer;
use crate::managers::sessions::{Arming, Inactivity};
use crate::router::types::ConnectionHandle;

pub(crate) struct NeverArming;

impl Arming for NeverArming {
    fn arm(
        &self,
        _due: Duration,
        _timer: (Inactivity, ConnectionHandle),
    ) -> Result<Arc<dyn Timer>, crate::errors::ProgrammerError> {
        panic!("sessions with NEVER timeouts arm no timer")
    }
}
