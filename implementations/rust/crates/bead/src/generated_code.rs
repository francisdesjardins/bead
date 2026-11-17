//! The contract between generated code and this runtime (decision 0018), a counter from 1: a
//! generated file names the highest it needs, as a constant of its own, so a runtime too old for it
//! fails its build, E0425 where the other sides fail with TS2724 and CS0117. The counter is one
//! number a contract on every side, moved together: the Rust runtime meets the contracts 7 and 8, and
//! 5 where its gateway is built, and holds those alone, since no Rust code ever named an older one
//! (decisions 0051 and 0052). It moves only
//! when generated code needs something the runtime did not have. Before 1.0.0, an older constant
//! goes once the code that names it no longer conforms through this runtime; from 1.0.0 it stays for
//! the whole major. It names no release.

#[cfg(test)]
mod tests;

/// The runtime carries what a package's file of HTTP routes names (decisions 0037 and 0052).
///
/// A gateway's route table, [`HttpRoute`](crate::HttpRoute) and
/// [`route_of`](crate::route_of), its payloads and methods, and its caller, which a generated
/// `bead_http.rs` names under the feature `gateway`.
#[cfg(feature = "gateway")]
pub const GENERATED_CODE_SUPPORTS_VERSION_5: bool = true;

/// The runtime carries what a package's file of services names (decisions 0018, 0035 and 0051).
///
/// The service layer, its descriptors, its catalogue and its codecs, the server's and the client's
/// shells over [`ServiceServer`](crate::ServiceServer) and [`ServiceClient`](crate::ServiceClient),
/// a command's [`CommandOptions`](crate::CommandOptions) and its [`Notifier`](crate::Notifier); and,
/// through `bead_protobuf`, which answers to this counter, the codec of a `proto` message and the
/// validators' runtime a request's generated rules judge by.
pub const GENERATED_CODE_SUPPORTS_VERSION_7: bool = true;

/// The runtime carries a server transport's option `procedures`, beside the contract 7.
///
/// The addresses a transport takes, which a generated `bead_served.rs` gives each transport of a
/// server by the key `beadc.yaml` names it (decision 0048).
pub const GENERATED_CODE_SUPPORTS_VERSION_8: bool = true;
