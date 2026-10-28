//! The managers: a server's notifications and their pacing, its sessions, and the service manager
//! both sides run their procedures through.

pub(crate) mod notification;
pub(crate) mod service;
pub(crate) mod sessions;

#[cfg(test)]
mod tests;
