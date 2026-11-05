//! Result-returning futures carry their errors; private helpers and trait implementations inherit.

// refused: a public future of a Result has no Errors section
pub fn missing() -> BoxFuture<Result<(), Failure>> { todo!() }

/// # Errors
/// When its transport fails.
pub fn stated() -> BoxFuture<Result<(), Failure>> { todo!() }

pub fn infallible() -> BoxFuture<()> { todo!() }
fn private() -> BoxFuture<Result<(), Failure>> { todo!() }

pub trait Port {
    // refused: the trait declares the promise
    fn missing(&self) -> Pin<Box<dyn Future<Output = Result<(), Failure>>>>;

    /// # Errors
    /// When its transport fails.
    fn stated(&self) -> impl Future<Output = Result<(), Failure>>;
}

impl Port for Transport {
    fn missing(&self) -> BoxFuture<Result<(), Failure>> { todo!() }
    fn stated(&self) -> BoxFuture<Result<(), Failure>> { todo!() }
}

impl Transport {
    // refused: public inherent methods state their promise
    pub fn missing(&self) -> std::pin::Pin<Box<dyn std::future::Future<Output = std::result::Result<(), Failure>> + Send>> { todo!() }
    fn private(&self) -> BoxFuture<Result<(), Failure>> { todo!() }
}
