//! The HTTP/JSON gateway (spec/transcoding.md, decisions 0037 and 0052): a service's procedures
//! answered as HTTP routes, each call made as one more client of its application's server, on its
//! own listener, the HTTP transport's wire, or mounted on its application's own server; its bodies,
//! the one it answers and the one it is handed; the pace its responses are held to; and its caller,
//! which calls a gateway's default routes.

pub(crate) mod body;
pub(crate) mod caller;
pub(crate) mod host;
pub(crate) mod pace;
