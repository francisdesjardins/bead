//! What a transport over a socket does alike, whatever its protocol (decisions 0049, 0050): how a
//! server binds `localhost`, the bounds it holds a socket to, and how it closes a socket in stages;
//! how a client races a name's addresses and dials its socket, the TLS either end speaks, and what
//! hands a client the credential its link carries.

#[cfg(any(feature = "websocket", feature = "http"))]
pub(crate) mod bounds;
#[cfg(any(feature = "websocket", feature = "mqtt"))]
pub(crate) mod credential;
#[cfg(any(feature = "websocket", feature = "mqtt"))]
pub(crate) mod dial;
#[cfg(any(feature = "websocket", feature = "http"))]
pub(crate) mod linger;
#[cfg(any(feature = "websocket", feature = "http"))]
pub(crate) mod listening;
#[cfg(any(feature = "websocket", feature = "http"))]
pub(crate) mod loopbacks;
pub(crate) mod racing;
pub(crate) mod tls;
