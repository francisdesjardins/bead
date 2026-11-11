//! What a transport over a socket does alike, whatever its protocol (decision 0049): how a server
//! binds `localhost`, the bounds it holds a socket to, and how it closes a socket in stages; how a
//! client races a name's addresses, and the TLS either end speaks.

pub(crate) mod bounds;
pub(crate) mod linger;
pub(crate) mod listening;
pub(crate) mod loopbacks;
pub(crate) mod racing;
pub(crate) mod tls;
