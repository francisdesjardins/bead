//! The parameter rule (decision 0044, as 0007 holds it on the other sides): beside its receiver, a
//! function takes at most two parameters, then at most one options struct, always last, its type
//! named `…Options`, under a reference or an `Option` if need be. A tuple taken whole is one
//! parameter, as a written tuple is one on the TypeScript side. A trait's methods are judged where
//! the trait declares them, never where a type implements them, so a trait of another crate's,
//! `serde`'s among them, writes its own.

use syn::visit::Visit;
use syn::{FnArg, GenericArgument, ItemFn, ItemImpl, PathArguments, Signature, Type};

use crate::Finding;

// what a third parameter, a fourth, or an options struct out of its place is refused for
const FOURTH: &str = "two parameters, then at most one options struct: this is a fourth";
const THIRD: &str = "a third parameter is the options struct: one whose type is named `…Options`";
const NOT_LAST: &str = "the options struct comes last";
const SECOND: &str = "one options struct, at most";

// the type an options struct is named by, under a reference or an `Option`
fn names_options(written: &Type) -> bool {
    match written {
        Type::Reference(reference) => names_options(&reference.elem),
        Type::Paren(paren) => names_options(&paren.elem),
        Type::Group(group) => names_options(&group.elem),
        Type::Path(path) => path.path.segments.last().is_some_and(|segment| {
            if segment.ident == "Option"
                && let PathArguments::AngleBracketed(arguments) = &segment.arguments
                && let Some(GenericArgument::Type(inner)) = arguments.args.first()
            {
                return names_options(inner);
            }

            segment.ident.to_string().ends_with("Options")
        }),
        Type::Array(_)
        | Type::FnPtr(_)
        | Type::ImplTrait(_)
        | Type::Infer(_)
        | Type::Macro(_)
        | Type::Never(_)
        | Type::Ptr(_)
        | Type::Slice(_)
        | Type::TraitObject(_)
        | Type::Tuple(_)
        | Type::Verbatim(_)
        | _ => false,
    }
}

#[derive(Default)]
struct Judge {
    findings: Vec<Finding>,
    // within an implementation of a trait, whose signatures its trait declares
    is_implementing: bool,
}

impl Judge {
    fn judge(&mut self, signature: &Signature) {
        // the parameters beside the receiver, each by its line and whether it names options
        let parameters: Vec<(usize, bool)> = signature
            .inputs
            .iter()
            .filter_map(|input| match input {
                FnArg::Typed(typed) => {
                    let line = typed
                        .colon_token
                        .spans
                        .first()
                        .map_or(0, |span| span.start().line);

                    Some((line, names_options(&typed.ty)))
                }
                FnArg::Receiver(_) => None,
            })
            .collect();
        let count = parameters.len();

        for (index, &(line, is_options)) in parameters.iter().enumerate() {
            let position = index.saturating_add(1);

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
        }

        let options: Vec<usize> = parameters
            .iter()
            .filter(|(_, is_options)| *is_options)
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
            self.judge(signature);
        }

        syn::visit::visit_signature(self, signature);
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
