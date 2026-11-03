//! The cases of the options struct's shape: a line the rule refuses follows a comment of its own,
//! `// refused:` and why, and every other line is one it accepts. No crate compiles this file: the
//! house's test reads it, and fails unless the lines refused are exactly the ones marked.

// ── Every member optional ─────────────────────────────────────────────────────────────────────

/// Every member an `Option`, `Default` derived.
#[derive(Debug, Clone, Default)]
#[non_exhaustive]
pub struct AllOptionalOptions {
    pub timeout: Option<u64>,
    pub label: Option<String>,
}

/// Its `Default` written by hand.
#[derive(Debug, Clone)]
#[non_exhaustive]
pub struct HandDefaultOptions {
    pub timeout: Option<u64>,
}

impl Default for HandDefaultOptions {
    fn default() -> Self {
        Self { timeout: None }
    }
}

/// A struct no options name, judged by no rule of these.
#[derive(Clone, Copy)]
pub struct Settings {
    pub timeout: u64,
}

/// An options struct of the crate's own, judged by no rule of these.
#[derive(Clone, Copy)]
pub(crate) struct InnerOptions {
    timeout: u64,
}

// refused: not non_exhaustive
#[derive(Debug, Clone, Default)]
pub struct OpenOptions {
    pub timeout: Option<u64>,
}

// refused: Copy, taken by `&` then
#[derive(Debug, Clone, Copy, Default)]
#[non_exhaustive]
pub struct CopiedOptions {
    pub is_clean: Option<bool>,
}

/// A doc comment, then the verdict at its first attribute.
// refused: no Default where none is required
#[derive(Debug, Clone)]
#[non_exhaustive]
pub struct UndefaultedOptions {
    pub timeout: Option<u64>,
}

#[derive(Debug, Clone, Default)]
#[non_exhaustive]
pub struct HalfPublicOptions {
    pub timeout: Option<u64>,
    // refused: a field of its own
    label: Option<String>,
}

#[derive(Debug, Clone)]
#[non_exhaustive]
pub struct PlainOptions {
    // refused: a plain field and no constructor that takes it
    pub verifies: bool,
}

// ── A required member, which its constructor takes ───────────────────────────────────────────

/// One required member, set by its constructor.
#[derive(Debug, Clone)]
#[non_exhaustive]
pub struct ConnectOptions {
    pub server: String,
    pub timeout: Option<u64>,
}

impl ConnectOptions {
    pub fn of(server: String) -> Self {
        Self {
            server,
            timeout: None,
        }
    }
}

/// Two required members, the constructor's word its own.
#[derive(Debug, Clone)]
#[non_exhaustive]
pub struct AddressOptions {
    pub host: String,
    pub port: u16,
    pub timeout: Option<u64>,
}

impl AddressOptions {
    pub const fn new(port: u16, host: String) -> AddressOptions {
        AddressOptions {
            host,
            port,
            timeout: None,
        }
    }
}

// refused: a required member and a `Default` that builds it without
#[derive(Debug, Clone, Default)]
#[non_exhaustive]
pub struct DefaultedOptions {
    pub id: String,
}

impl DefaultedOptions {
    pub fn of(id: String) -> Self {
        Self { id }
    }
}

#[derive(Debug, Clone)]
#[non_exhaustive]
pub struct UnbuiltOptions {
    // refused: a required member no constructor takes
    pub id: String,
}

#[derive(Debug, Clone)]
#[non_exhaustive]
pub struct PartlyBuiltOptions {
    // refused: its constructor takes another, so not this one
    pub id: String,
    // refused: nor this one
    pub server: String,
}

impl PartlyBuiltOptions {
    pub fn of(id: String) -> Self {
        Self {
            id,
            server: String::new(),
        }
    }
}

#[derive(Debug, Clone)]
#[non_exhaustive]
pub struct OverTakenOptions {
    // refused: its constructor takes more than its required members
    pub id: String,
}

impl OverTakenOptions {
    pub fn of(id: String, timeout: u64) -> Self {
        Self { id }
    }
}

// refused: three required members
#[derive(Debug, Clone)]
#[non_exhaustive]
pub struct ThreeOptions {
    pub host: String,
    pub port: u16,
    pub id: String,
}

impl ThreeOptions {
    pub fn of(host: String, port: u16, id: String) -> Self {
        Self { host, port, id }
    }
}

// ── Within a module ──────────────────────────────────────────────────────────────────────────

pub mod inner {
    // refused: judged within its module too
    #[derive(Debug, Clone, Copy, Default)]
    #[non_exhaustive]
    pub struct NestedOptions {
        pub timeout: Option<u64>,
    }
}
