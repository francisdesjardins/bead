//! The options struct's shape (decision 0044, the rule 0004 states for every side): each public
//! struct named `…Options` is `#[non_exhaustive]`, never `Copy`, its fields public, each an
//! `Option` but a setting it cannot be built without, at most two of them, which its constructor
//! of the required members sets: an associated function of its own `impl`, `new` (C-CTOR), that
//! takes those fields, by their names, and nothing else, and gives `Self`, as C-BUILDER's
//! `Command::new(program)` takes its program. Such a struct has no `Default`; one with none
//! required derives it.

use std::collections::BTreeMap;

use syn::{
    Attribute, Fields, FnArg, ImplItem, Item, ItemStruct, Pat, PathArguments, ReturnType, Type,
    Visibility,
};

use crate::Finding;

const NOT_NON_EXHAUSTIVE: &str = "an options struct is `#[non_exhaustive]`";
const COPY: &str = "an options struct is never `Copy`: it is taken by `&`";
const NOT_PUBLIC: &str = "an options struct's fields are public";
const NOT_OPTION: &str = "an options struct's field is an `Option`, but a required member, which its constructor of the required members takes";
const MORE_THAN_TWO: &str = "an options struct requires two members at most";
const DEFAULT_WITH_REQUIRED: &str =
    "an options struct with a required member has no `Default`: its constructor builds it";
const NO_DEFAULT: &str = "an options struct with no required member derives `Default`";
const NOT_NEW: &str = "an options struct's constructor of its required members is `new` (C-CTOR)";

// what the attributes of an item derive, by each trait's last name
fn derived_of(attributes: &[Attribute]) -> Vec<String> {
    attributes
        .iter()
        .filter(|attribute| attribute.path().is_ident("derive"))
        .flat_map(|attribute| {
            let mut names = Vec::new();

            // a derive that does not parse derives nothing this rule reads
            attribute
                .parse_nested_meta(|meta| {
                    if let Some(last) = meta.path.segments.last() {
                        names.push(last.ident.to_string());
                    }

                    Ok(())
                })
                .ok();

            names
        })
        .collect()
}

// whether the attributes hold `#[non_exhaustive]`
fn is_non_exhaustive(attributes: &[Attribute]) -> bool {
    attributes
        .iter()
        .any(|attribute| attribute.path().is_ident("non_exhaustive"))
}

// whether `written` is an `Option<…>`
fn is_option(written: &Type) -> bool {
    let Type::Path(path) = written else {
        return false;
    };

    path.path.segments.last().is_some_and(|segment| {
        segment.ident == "Option" && matches!(segment.arguments, PathArguments::AngleBracketed(_))
    })
}

// the name a type's path ends with: the type an `impl` is for
fn name_of(written: &Type) -> Option<String> {
    let Type::Path(path) = written else {
        return None;
    };

    path.path
        .segments
        .last()
        .map(|segment| segment.ident.to_string())
}

// an associated function that gives `Self`
struct Constructor {
    word: String,
    line: usize,
    parameters: Vec<String>,
}

// what one file's `impl`s say of each type, by its name
#[derive(Default)]
struct Implemented {
    // the traits implemented, by their last name
    traits: Vec<String>,
    // each associated function that gives `Self`: its word, its line, and its parameters' names
    constructors: Vec<Constructor>,
}

fn implemented_of(items: &[Item], found: &mut BTreeMap<String, Implemented>) {
    for item in items {
        match item {
            Item::Impl(implementation) => {
                let Some(name) = name_of(&implementation.self_ty) else {
                    continue;
                };
                let entry = found.entry(name.clone()).or_default();

                if let Some((path, _)) = &implementation.trait_ {
                    if let Some(last) = path.segments.last() {
                        entry.traits.push(last.ident.to_string());
                    }

                    continue;
                }

                for inner in &implementation.items {
                    let ImplItem::Fn(function) = inner else {
                        continue;
                    };
                    let signature = &function.sig;
                    let gives_self = match &signature.output {
                        ReturnType::Type(_, given) => {
                            name_of(given).is_some_and(|given| given == "Self" || given == name)
                        }
                        ReturnType::Default => false,
                    };
                    let parameters: Option<Vec<String>> = signature
                        .inputs
                        .iter()
                        .map(|input| match input {
                            FnArg::Typed(typed) => {
                                if let Pat::Ident(named) = &*typed.pat {
                                    Some(named.ident.to_string())
                                } else {
                                    None
                                }
                            }
                            FnArg::Receiver(_) => None,
                        })
                        .collect();

                    if gives_self && let Some(parameters) = parameters {
                        entry.constructors.push(Constructor {
                            word: signature.ident.to_string(),
                            line: signature.ident.span().start().line,
                            parameters,
                        });
                    }
                }
            }
            Item::Mod(module) => {
                if let Some((_, inner)) = &module.content {
                    implemented_of(inner, found);
                }
            }
            Item::Const(_)
            | Item::Enum(_)
            | Item::ExternCrate(_)
            | Item::Fn(_)
            | Item::ForeignMod(_)
            | Item::Macro(_)
            | Item::Static(_)
            | Item::Struct(_)
            | Item::Trait(_)
            | Item::TraitAlias(_)
            | Item::Type(_)
            | Item::Union(_)
            | Item::Use(_)
            | Item::Verbatim(_)
            | _ => {}
        }
    }
}

fn structs_of<'file>(items: &'file [Item], found: &mut Vec<&'file ItemStruct>) {
    for item in items {
        match item {
            Item::Struct(declared)
                if matches!(declared.vis, Visibility::Public(_))
                    && declared.ident.to_string().ends_with("Options") =>
            {
                found.push(declared);
            }
            Item::Mod(module) => {
                if let Some((_, inner)) = &module.content {
                    structs_of(inner, found);
                }
            }
            Item::Const(_)
            | Item::Enum(_)
            | Item::ExternCrate(_)
            | Item::Fn(_)
            | Item::ForeignMod(_)
            | Item::Impl(_)
            | Item::Macro(_)
            | Item::Static(_)
            | Item::Struct(_)
            | Item::Trait(_)
            | Item::TraitAlias(_)
            | Item::Type(_)
            | Item::Union(_)
            | Item::Use(_)
            | Item::Verbatim(_)
            | _ => {}
        }
    }
}

// the line an item's verdict is given at: its first attribute that is no doc comment, or its
// `struct`
fn line_of(declared: &ItemStruct) -> usize {
    declared
        .attrs
        .iter()
        .find(|attribute| !attribute.path().is_ident("doc"))
        .map_or_else(
            || declared.struct_token.span.start().line,
            |attribute| attribute.pound_token.span.start().line,
        )
}

fn judge(declared: &ItemStruct, implemented: Option<&Implemented>) -> Vec<Finding> {
    let mut findings = Vec::new();
    let line = line_of(declared);
    let derived = derived_of(&declared.attrs);
    let implements = |name: &str| {
        derived.iter().any(|derive| derive == name)
            || implemented
                .is_some_and(|implemented| implemented.traits.iter().any(|trait_| trait_ == name))
    };

    if !is_non_exhaustive(&declared.attrs) {
        findings.push(Finding {
            line,
            reason: NOT_NON_EXHAUSTIVE,
        });
    }

    if implements("Copy") {
        findings.push(Finding { line, reason: COPY });
    }

    let Fields::Named(fields) = &declared.fields else {
        return findings;
    };
    // the plain fields, each by its name and line
    let mut plain: Vec<(String, usize)> = Vec::new();

    for field in &fields.named {
        let Some(ident) = &field.ident else {
            continue;
        };
        let field_line = ident.span().start().line;

        if !matches!(field.vis, Visibility::Public(_)) {
            findings.push(Finding {
                line: field_line,
                reason: NOT_PUBLIC,
            });
        }

        if !is_option(&field.ty) {
            plain.push((ident.to_string(), field_line));
        }
    }

    let mut names: Vec<&str> = plain.iter().map(|(name, _)| name.as_str()).collect();

    names.sort_unstable();

    // a constructor of the required members: their names, and nothing else
    let constructors: Vec<&Constructor> = implemented
        .filter(|_| !plain.is_empty())
        .map(|implemented| {
            implemented
                .constructors
                .iter()
                .filter(|constructor| {
                    let mut taken: Vec<&str> =
                        constructor.parameters.iter().map(String::as_str).collect();

                    taken.sort_unstable();
                    taken == names
                })
                .collect()
        })
        .unwrap_or_default();
    let is_constructed = !constructors.is_empty();

    for constructor in constructors
        .iter()
        .filter(|constructor| constructor.word != "new")
    {
        findings.push(Finding {
            line: constructor.line,
            reason: NOT_NEW,
        });
    }

    if !is_constructed {
        for (_, field_line) in &plain {
            findings.push(Finding {
                line: *field_line,
                reason: NOT_OPTION,
            });
        }
    }

    if plain.len() > 2 {
        findings.push(Finding {
            line,
            reason: MORE_THAN_TWO,
        });
    }

    if plain.is_empty() && !implements("Default") {
        findings.push(Finding {
            line,
            reason: NO_DEFAULT,
        });
    } else if !plain.is_empty() && implements("Default") {
        findings.push(Finding {
            line,
            reason: DEFAULT_WITH_REQUIRED,
        });
    }

    findings
}

/// What the options struct's shape refuses in `file`, each by its line: a struct's own at its first
/// attribute that is no doc comment, a field's at its name.
#[must_use]
pub fn options_of(file: &syn::File) -> Vec<Finding> {
    let mut implemented = BTreeMap::new();
    let mut structs = Vec::new();

    implemented_of(&file.items, &mut implemented);
    structs_of(&file.items, &mut structs);

    let mut findings: Vec<Finding> = structs
        .into_iter()
        .flat_map(|declared| judge(declared, implemented.get(&declared.ident.to_string())))
        .collect();

    findings.sort_by_key(|finding| finding.line);
    findings
}
