//! The cases of the parameter rule: a line the rule refuses follows a comment of its own, `// refused:`
//! and why, and every other line is one it accepts. No crate compiles this file: the house's test
//! reads it, and fails unless the lines refused are exactly the ones marked.

pub struct GoodOptions;

pub struct Other;

// ── Two parameters, then the options struct ──────────────────────────────────

pub fn none() {}

pub fn one(a: u32) {}

pub fn two(a: u32, b: u32) {}

pub fn two_then_options(a: u32, b: u32, options: &GoodOptions) {}

pub fn options_alone(options: &GoodOptions) {}

// a reference to a struct no options name is judged by no form
pub fn others(a: &Other, b: Option<&Other>) {}

// refused: a third positional
pub fn third_positional(a: u32, b: u32, c: u32) {}

// refused: a third positional, of another struct
pub fn third_other(a: u32, b: u32, c: Other) {}

// refused: the options not last
pub fn options_first(options: &GoodOptions, a: u32) {}

// refused: a fourth, the options not last
pub fn fourth(a: u32, b: u32, options: GoodOptions, d: u32) {}

// a tuple taken whole is one parameter
pub fn tupled((a, b, c): (u32, u32, u32), (d, e): (u32, u32)) {}

// ── Beside a receiver ────────────────────────────────────────────────────────

pub struct Router;

impl Router {
    pub fn two(&self, a: u32, b: u32) {}

    pub fn two_then_options(&mut self, a: u32, b: u32, options: &GoodOptions) {}

    // refused: a third positional beside its receiver
    pub fn third(self, a: u32, b: u32, c: u32) {}
}

pub trait Side {
    fn two(&self, a: u32, b: u32);

    // refused: a third positional in a trait's signature
    fn third(&self, a: u32, b: u32, c: u32);
}

// refused: one options struct, at most
pub fn twice(a: u32, first: &GoodOptions, second: &GoodOptions) {}

// ── Taken by `&` ─────────────────────────────────────────────────────────────

// refused: by value
pub fn by_value(options: GoodOptions) {}

// refused: by `&mut`
pub fn by_mut(a: u32, options: &mut GoodOptions) {}

// refused: in an `Option`, where `&GoodOptions::default()` stands for none
pub fn in_option(a: u32, options: Option<&GoodOptions>) {}

// refused: under two references
pub fn twice_borrowed(options: &&GoodOptions) {}

// a tuple taken whole is judged by no form of its own
pub fn tupled_options((a, options): (u32, GoodOptions)) {}

// ── A callback a type alias declares ─────────────────────────────────────────

pub type Judge<T> = Arc<dyn Fn(&T, &GoodOptions) -> bool + Send + Sync>;

// refused: a callback's options by value
pub type ByValue<T> = Arc<dyn Fn(&T, GoodOptions) -> bool + Send + Sync>;

// refused: a callback's third positional and its fourth
pub type Fourth = Box<dyn Fn(u32, u32, u32, u32) + Send>;

// refused: a callback's options not last
pub type NotLast = fn(&GoodOptions, u32);

// a trait's method is judged where its trait declares it, a trait of another crate's among them
impl Side for Router {
    fn two(&self, a: u32, b: u32) {}

    fn third(&self, a: u32, b: u32, c: u32) {}
}

impl serde::Serializer for Router {
    fn serialize_unit_variant(self, name: &'static str, index: u32, variant: &'static str) {}
}

// a function within an implementation's method is judged as any other
impl Router {
    pub fn outer(&self) {
        // refused: a third positional of a function within a method
        fn inner(a: u32, b: u32, c: u32) {}
    }
}
