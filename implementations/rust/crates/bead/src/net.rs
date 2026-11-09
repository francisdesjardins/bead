//! What a server over a socket does alike, whatever its protocol (decision 0049): how it binds
//! `localhost`, the bounds it holds a socket to, and how it closes a socket in stages.

pub(crate) mod bounds;
pub(crate) mod linger;
pub(crate) mod loopbacks;
