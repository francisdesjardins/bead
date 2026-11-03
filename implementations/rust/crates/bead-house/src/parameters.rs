//! The parameter rule (decision 0044, as 0007 holds it on the other sides, and 0004 on every side):
//! beside its receiver, a function takes at most two parameters, then at most one options struct,
//! always last, its type named `…Options`, taken by `&`: never by value, by `&mut` or in an
//! `Option`, since `&…Options::default()` stands for none. The count binds every function: inside
//! a crate a tuple taken whole is one parameter, as a written tuple is one on the TypeScript side,
//! and on the surface `tuples.rs` refuses it. A trait's methods are judged where the trait
//! declares them, never where a type implements them, so a trait of another crate's, `serde`'s
//! among them, writes its own; a callback a type alias declares, by `Fn(…)`'s sugar or a function
//! pointer, is judged as a function is.

use syn::punctuated::Punctuated;
use syn::visit::Visit;
use syn::{
    FnArg, GenericArgument, ItemFn, ItemImpl, ItemType, NamedArg, ParenthesizedGenericArguments,
    PathArguments, Signature, Token, Type, TypeFnPtr,
};

use crate::Finding;

// what a third parameter, a fourth, or an options struct out of its place or its form is refused
// for
const FOURTH: &str = "two parameters, then at most one options struct: this is a fourth";
const THIRD: &str = "a third parameter is the options struct: one whose type is named `…Options`";
const NOT_LAST: &str = "the options struct comes last";
const SECOND: &str = "one options struct, at most";
const NOT_BORROWED: &str =
    "an options struct is taken by `&`: never by value, by `&mut` or in an `Option`";

// how a parameter's type names an options struct
#[derive(Clone, Copy, PartialEq, Eq)]
enum Taken {
    // it names none
    No,
    // `&…Options`, its one form
    Borrowed,
    // by value, by `&mut`, in an `Option` or under more than one reference
    Otherwise,
}

// whether a path type's last segment names an options struct, and the type an `Option` holds
fn named_of(written: &Type) -> (bool, Option<&Type>) {
    let Type::Path(path) = written else {
        return (false, None);
    };
    let Some(segment) = path.path.segments.last() else {
        return (false, None);
    };

    if segment.ident == "Option"
        && let PathArguments::AngleBracketed(arguments) = &segment.arguments
        && let Some(GenericArgument::Type(inner)) = arguments.args.first()
    {
        return (false, Some(inner));
    }

    (segment.ident.to_string().ends_with("Options"), None)
}

// what a reference, a group or parentheses hold
fn unwrapped(written: &Type) -> &Type {
    match written {
        Type::Paren(paren) => unwrapped(&paren.elem),
        Type::Group(group) => unwrapped(&group.elem),
        Type::Array(_)
        | Type::FnPtr(_)
        | Type::ImplTrait(_)
        | Type::Infer(_)
        | Type::Macro(_)
        | Type::Never(_)
        | Type::Path(_)
        | Type::Ptr(_)
        | Type::Reference(_)
        | Type::Slice(_)
        | Type::TraitObject(_)
        | Type::Tuple(_)
        | Type::Verbatim(_)
        | _ => written,
    }
}

// how `written` names an options struct, under references or an `Option` if need be
fn taken_of(written: &Type) -> Taken {
    match unwrapped(written) {
        Type::Reference(reference) => {
            let held = unwrapped(&reference.elem);

            if reference.mutability.is_none() && matches!(named_of(held), (true, None)) {
                Taken::Borrowed
            } else if taken_of(held) == Taken::No {
                Taken::No
            } else {
                Taken::Otherwise
            }
        }
        path @ Type::Path(_) => match named_of(path) {
            (true, _) => Taken::Otherwise,
            (false, Some(inner)) if taken_of(inner) != Taken::No => Taken::Otherwise,
            (false, _) => Taken::No,
        },
        Type::Array(_)
        | Type::FnPtr(_)
        | Type::Group(_)
        | Type::ImplTrait(_)
        | Type::Infer(_)
        | Type::Macro(_)
        | Type::Never(_)
        | Type::Paren(_)
        | Type::Ptr(_)
        | Type::Slice(_)
        | Type::TraitObject(_)
        | Type::Tuple(_)
        | Type::Verbatim(_)
        | _ => Taken::No,
    }
}

// a type's first line, as far as its own tokens tell it; `around` when they do not
fn line_of(written: &Type, around: usize) -> usize {
    match written {
        Type::Reference(reference) => reference.and_token.span.start().line,
        Type::Paren(paren) => paren.paren_token.span.open().start().line,
        Type::Path(path) => path
            .path
            .segments
            .first()
            .map_or(around, |segment| segment.ident.span().start().line),
        Type::Tuple(tuple) => tuple.paren_token.span.open().start().line,
        Type::Array(_)
        | Type::FnPtr(_)
        | Type::Group(_)
        | Type::ImplTrait(_)
        | Type::Infer(_)
        | Type::Macro(_)
        | Type::Never(_)
        | Type::Ptr(_)
        | Type::Slice(_)
        | Type::TraitObject(_)
        | Type::Verbatim(_)
        | _ => around,
    }
}

#[derive(Default)]
struct Judge {
    findings: Vec<Finding>,
    // within an implementation of a trait, whose signatures its trait declares
    is_implementing: bool,
}

impl Judge {
    fn judge_signature(&mut self, signature: &Signature) {
        // the parameters beside the receiver, each by its line and how it names options
        let parameters: Vec<(usize, Taken)> = signature
            .inputs
            .iter()
            .filter_map(|input| match input {
                FnArg::Typed(typed) => {
                    let line = typed
                        .colon_token
                        .spans
                        .first()
                        .map_or(0, |span| span.start().line);

                    Some((line, taken_of(&typed.ty)))
                }
                FnArg::Receiver(_) => None,
            })
            .collect();

        self.judge(&parameters);
    }

    // a callback's parameters, as `Fn(…)`'s sugar or a function pointer writes them
    fn judge_callback(&mut self, (inputs, around): (&Punctuated<NamedArg, Token![,]>, usize)) {
        let parameters: Vec<(usize, Taken)> = inputs
            .iter()
            .map(|argument| (line_of(&argument.ty, around), taken_of(&argument.ty)))
            .collect();

        self.judge(&parameters);
    }

    fn judge(&mut self, parameters: &[(usize, Taken)]) {
        let count = parameters.len();

        for (index, &(line, taken)) in parameters.iter().enumerate() {
            let position = index.saturating_add(1);
            let is_options = taken != Taken::No;

            if position > 3 {
                self.findings.push(Finding {
                    line,
                    reason: FOURTH,
                });
            } else if position == 3 && !is_options {
                self.findings.push(Finding {
                    line,
                    reason: THIRD,
                });
            } else if is_options && position < count {
                self.findings.push(Finding {
                    line,
                    reason: NOT_LAST,
                });
            }

            if taken == Taken::Otherwise {
                self.findings.push(Finding {
                    line,
                    reason: NOT_BORROWED,
                });
            }
        }

        let options: Vec<usize> = parameters
            .iter()
            .filter(|(_, taken)| *taken != Taken::No)
            .map(|(line, _)| *line)
            .collect();

        if let [_, second, ..] = options.as_slice() {
            self.findings.push(Finding {
                line: *second,
                reason: SECOND,
            });
        }
    }
}

// every `Fn(…)` and `fn(…)` a type alias's type writes, the alias's line for a type that tells
// none
struct Callbacks<'judge> {
    judge: &'judge mut Judge,
    around: usize,
}

impl<'ast> Visit<'ast> for Callbacks<'_> {
    fn visit_parenthesized_generic_arguments(
        &mut self,
        callback: &'ast ParenthesizedGenericArguments,
    ) {
        self.judge.judge_callback((&callback.inputs, self.around));
        syn::visit::visit_parenthesized_generic_arguments(self, callback);
    }

    fn visit_type_fn_ptr(&mut self, callback: &'ast TypeFnPtr) {
        self.judge.judge_callback((&callback.inputs, self.around));
        syn::visit::visit_type_fn_ptr(self, callback);
    }
}

impl<'ast> Visit<'ast> for Judge {
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
            self.judge_signature(signature);
        }

        syn::visit::visit_signature(self, signature);
    }

    fn visit_item_type(&mut self, item: &'ast ItemType) {
        let around = item.type_token.span.start().line;

        Callbacks {
            judge: self,
            around,
        }
        .visit_type(&item.ty);
    }
}

/// What the parameter rule refuses in `file`, each by its line.
#[must_use]
pub fn parameters_of(file: &syn::File) -> Vec<Finding> {
    let mut judge = Judge::default();

    judge.visit_file(file);
    judge.findings.sort_by_key(|finding| finding.line);
    judge.findings
}
