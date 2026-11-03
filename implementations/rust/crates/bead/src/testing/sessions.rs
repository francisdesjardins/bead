//! Sessions whose timeouts are NEVER: arming any timer fails the test.

use core::time::Duration;
use std::sync::Arc;

use crate::clock::Timer;
use crate::managers::sessions::{Arming, Inactivity};
use crate::router::types::ConnectionHandle;

pub(crate) struct NeverArming;

impl Arming for NeverArming {
    fn arm(&self, _due: Duration, _timer: (Inactivity, ConnectionHandle)) -> Arc<dyn Timer> {
        panic!("sessions with NEVER timeouts arm no timer")
    }
}
