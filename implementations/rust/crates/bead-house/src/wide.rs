//! The tuples of three elements or more a function takes (decision 0044, as 0006 lists the gate):
//! inside a crate a tuple is one parameter, which the parameter rule counts as such
//! (`parameters.rs`), so a third essential thing can hide in one. The rule counts them, and the
//! house's test holds each crate's count to its pin, which may only fall: a site leaves the count
//! by a record of the call, and none joins it.
//!
//! What is read is a parameter's own type alone, under its references, a group or parentheses: a
//! tuple nested in a type's argument, a field, a local or a closure's parameter is no parameter of
//! a function. A trait's methods are counted where the trait declares them, never where a type
//! implements them, as the parameter rule judges them.

use syn::visit::Visit;
use syn::{FnArg, ItemFn, ItemImpl, Signature, Type};

use crate::Finding;

const WIDE: &str =
    "a tuple of three elements or more taken: a third essential thing is a record of the call";

// the tuple a parameter's own type is, under its references, a group or parentheses
fn tuple_of(written: &Type) -> Option<usize> {
    match written {
        Type::Reference(reference) => tuple_of(&reference.elem),
        Type::Paren(paren) => tuple_of(&paren.elem),
        Type::Group(group) => tuple_of(&group.elem),
        Type::Tuple(tuple) => Some(tuple.elems.len()),
        Type::Array(_)
        | Type::FnPtr(_)
        | Type::ImplTrait(_)
        | Type::Infer(_)
        | Type::Macro(_)
        | Type::Never(_)
        | Type::Path(_)
        | Type::Ptr(_)
        | Type::Slice(_)
        | Type::TraitObject(_)
        | Type::Verbatim(_)
        | _ => None,
    }
}

#[derive(Default)]
struct Counter {
    findings: Vec<Finding>,
    // within an implementation of a trait, whose signatures its trait declares
    is_implementing: bool,
}

impl Counter {
    fn count(&mut self, signature: &Signature) {
        for input in &signature.inputs {
            if let FnArg::Typed(typed) = input
                && tuple_of(&typed.ty).is_some_and(|elements| elements >= 3)
            {
                self.findings.push(Finding {
                    line: typed
                        .colon_token
                        .spans
                        .first()
                        .map_or(0, |span| span.start().line),
                    reason: WIDE,
                });
            }
        }
    }
}

impl<'ast> Visit<'ast> for Counter {
    fn visit_item_impl(&mut self, item: &'ast ItemImpl) {
        let was = core::mem::replace(&mut self.is_implementing, item.trait_.is_some());

        syn::visit::visit_item_impl(self, item);
        self.is_implementing = was;
    }

    fn visit_item_fn(&mut self, item: &'ast ItemFn) {
        let was = core::mem::replace(&mut self.is_implementing, false);

        syn::visit::visit_item_fn(self, item);
        self.is_implementing = was;
    }

    fn visit_signature(&mut self, signature: &'ast Signature) {
        if !self.is_implementing {
            self.count(signature);
        }

        syn::visit::visit_signature(self, signature);
    }
}

/// Each parameter of a function in `file` that takes a tuple of three elements or more, by its
/// line.
#[must_use]
pub fn wide_tuples_of(file: &syn::File) -> Vec<Finding> {
    let mut counter = Counter::default();

    counter.visit_file(file);
    counter.findings.sort_by_key(|finding| finding.line);
    counter.findings
}
