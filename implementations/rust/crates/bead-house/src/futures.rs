//! A future whose output is a Result documents its errors as a synchronous Result does.

use syn::visit::Visit;
use syn::{
    Attribute, Expr, GenericArgument, ImplItem, ItemFn, ItemImpl, ItemTrait, Lit, Meta,
    PathArguments, ReturnType, Signature, TraitItem, Type, TypeParamBound, Visibility,
};

use crate::Finding;

fn is_result(written: &Type) -> bool {
    matches!(written, Type::Path(path) if path.path.segments.last().is_some_and(|segment| segment.ident == "Result"))
}

fn future_bound(bound: &TypeParamBound) -> bool {
    let TypeParamBound::Trait(bound) = bound else {
        return false;
    };
    let Some(segment) = bound.path.segments.last() else {
        return false;
    };
    let PathArguments::AngleBracketed(arguments) = &segment.arguments else {
        return false;
    };

    segment.ident == "Future" && arguments.args.iter().any(|argument| {
        matches!(argument, GenericArgument::AssocType(output) if output.ident == "Output" && is_result(&output.ty))
    })
}

fn future_result(written: &Type) -> bool {
    match written {
        Type::Path(path) => path.path.segments.last().is_some_and(|segment| {
            let PathArguments::AngleBracketed(arguments) = &segment.arguments else {
                return false;
            };

            arguments.args.iter().any(|argument| {
                let GenericArgument::Type(inner) = argument else {
                    return false;
                };
                (segment.ident == "BoxFuture" && is_result(inner)) || future_result(inner)
            })
        }),
        Type::TraitObject(object) => object.bounds.iter().any(future_bound),
        Type::ImplTrait(object) => object.bounds.iter().any(future_bound),
        Type::Reference(reference) => future_result(&reference.elem),
        Type::Paren(paren) => future_result(&paren.elem),
        Type::Group(group) => future_result(&group.elem),
        Type::Array(_)
        | Type::FnPtr(_)
        | Type::Infer(_)
        | Type::Macro(_)
        | Type::Never(_)
        | Type::Ptr(_)
        | Type::Slice(_)
        | Type::Tuple(_)
        | Type::Verbatim(_)
        | _ => false,
    }
}

fn errors_documented(attributes: &[Attribute]) -> bool {
    attributes.iter().any(|attribute| {
        let Meta::NameValue(value) = &attribute.meta else {
            return false;
        };
        let Expr::Lit(value) = &value.value else {
            return false;
        };
        let Lit::Str(text) = &value.lit else {
            return false;
        };

        attribute.path().is_ident("doc")
            && text.value().lines().any(|line| line.trim() == "# Errors")
    })
}

#[derive(Default)]
struct Judge {
    findings: Vec<Finding>,
}

impl Judge {
    fn judge(&mut self, signature: &Signature, attributes: &[Attribute]) {
        if let ReturnType::Type(_, output) = &signature.output
            && future_result(output)
            && !errors_documented(attributes)
        {
            self.findings.push(Finding {
                line: signature.fn_token.span.start().line,
                reason: "a future of a Result documents its # Errors",
            });
        }
    }
}

impl<'ast> Visit<'ast> for Judge {
    fn visit_item_fn(&mut self, item: &'ast ItemFn) {
        if matches!(item.vis, Visibility::Public(_)) {
            self.judge(&item.sig, &item.attrs);
        }
    }

    fn visit_item_impl(&mut self, item: &'ast ItemImpl) {
        if item.trait_.is_some() {
            return;
        }

        for item in &item.items {
            if let ImplItem::Fn(method) = item
                && matches!(method.vis, Visibility::Public(_))
            {
                self.judge(&method.sig, &method.attrs);
            }
        }
    }

    fn visit_item_trait(&mut self, item: &'ast ItemTrait) {
        if !matches!(item.vis, Visibility::Public(_)) {
            return;
        }

        for item in &item.items {
            if let TraitItem::Fn(method) = item {
                self.judge(&method.sig, &method.attrs);
            }
        }
    }
}

/// What public futures of a Result in `file` leave undocumented, each by its line.
#[must_use]
pub fn futures_of(file: &syn::File) -> Vec<Finding> {
    let mut judge = Judge::default();

    judge.visit_file(file);
    judge.findings.sort_by_key(|finding| finding.line);
    judge.findings
}
