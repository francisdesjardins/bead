//! What a server judges of a request before its transport takes it, over HTTP as on a WebSocket's
//! upgrade (decision 0049): pure, its every input a request's text as it came, read by hand and
//! never by a URL parser, so that no request makes it panic. Each byte of a request past ASCII is
//! the character of its Latin-1 code here, as the TypeScript side's platform reads it, so a rule
//! that refuses an octet past ASCII refuses that character.
//!
//! Always built, whatever the features: the transports judge by it, and the fuzz targets and the
//! conformance players reach it through `bead::internal`.

pub mod handshake;
pub mod head;
pub mod hosts;
pub mod items;
pub mod proxies;
