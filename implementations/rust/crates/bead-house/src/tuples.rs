//! No tuple on the surface (decision 0004, as 0044 holds it): no item written `pub` takes or gives
//! a tuple, at any depth of its type, in a parameter, a return, a `pub` field, a `pub` type alias,
//! a constant or a static, nor takes a parameter by a tuple's pattern; no enum variant and no `pub`
//! tuple struct has two unnamed fields or more, a one-field newtype aside (C-NEWTYPE). The unit
//! `()` is no tuple, and a map's own type is none. An alias is judged by what it stands for, the
//! crate's own of every visibility among them, so a private `type Pair = (u32, u32)` carries no
//! tuple into a `pub` signature. A trait's methods are judged where the trait declares them. The
//! test kit, `testing`, is left out by name, as the surface list leaves it out, and so is what
//! `cfg(test)` alone keeps; what the kit's feature adds to the core's types is held to the rule.
//!
//! Inside the crate, a tuple is one parameter, which the parameter rule counts as such
//! (`parameters.rs`): the rule here is the surface's alone.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use syn::visit::Visit;
use syn::{
    Attribute, Fields, ImplItem, Item, Meta, PatTuple, Signature, TraitItem, Type, TypePath,
    TypeTuple, Visibility,
};

use crate::Finding;

const TUPLE: &str = "no tuple on the surface: what a caller passes or reads is named, a record of the call or a type of its own";
const PATTERN: &str =
    "no parameter taken as a tuple: two things are two parameters, a third a record of the call";
const UNNAMED: &str =
    "no variant or `pub` struct of two unnamed fields or more: each field is named";

fn is_public(visibility: &Visibility) -> bool {
    matches!(visibility, Visibility::Public(_))
}

// whether `cfg(test)` alone keeps the item: what the kit's feature adds is judged
fn is_tests_alone(attributes: &[Attribute]) -> bool {
    attributes.iter().any(|attribute| {
        attribute.path().is_ident("cfg")
            && matches!(&attribute.meta, Meta::List(list) if list.tokens.to_string() == "test")
    })
}

// ── The aliases ──────────────────────────────────────────────────────────────────────────────

// every type alias the items declare, of every visibility, by its name
fn aliases_in<'file>(items: &'file [Item], aliases: &mut BTreeMap<String, &'file Type>) {
    for item in items {
        if let Item::Type(alias) = item {
            aliases.insert(alias.ident.to_string(), &alias.ty);
        } else if let Item::Mod(module) = item
            && let Some((_, inner)) = &module.content
        {
            aliases_in(inner, aliases);
        }
    }
}

// ── Judging a type, a signature, an item ──────────────────────────────────────────────────────

// every tuple a type holds, at any depth, an alias judged by what it stands for, each refused at
// the line that names it
struct Types<'judged, 'file> {
    aliases: &'judged BTreeMap<String, &'file Type>,
    findings: &'judged mut Vec<Finding>,
    // the aliases being expanded, so one that names itself ends
    expanding: BTreeSet<String>,
    // the line an alias's tuple is refused at: where the alias is named
    named_at: Option<usize>,
}

impl Types<'_, '_> {
    fn refuse(&mut self, (line, reason): (usize, &'static str)) {
        self.findings.push(Finding {
            line: self.named_at.unwrap_or(line),
            reason,
        });
    }
}

impl<'ast> Visit<'ast> for Types<'_, '_> {
    fn visit_type_tuple(&mut self, tuple: &'ast TypeTuple) {
        if tuple.elems.is_empty() {
            return;
        }

        self.refuse((tuple.paren_token.span.open().start().line, TUPLE));
    }

    fn visit_pat_tuple(&mut self, pattern: &'ast PatTuple) {
        self.refuse((pattern.paren_token.span.open().start().line, PATTERN));
    }

    fn visit_type_path(&mut self, path: &'ast TypePath) {
        if let Some(last) = path.path.segments.last() {
            let name = last.ident.to_string();

            if let Some(stands_for) = self.aliases.get(&name)
                && !self.expanding.contains(&name)
            {
                let was = self.named_at;

                self.named_at = was.or_else(|| Some(last.ident.span().start().line));
                self.expanding.insert(name.clone());
                self.visit_type(stands_for);
                self.expanding.remove(&name);
                self.named_at = was;
            }
        }

        syn::visit::visit_type_path(self, path);
    }
}

struct Judge<'judged, 'file> {
    aliases: &'judged BTreeMap<String, &'file Type>,
    findings: Vec<Finding>,
}

impl<'file> Judge<'_, 'file> {
    fn types(&mut self) -> Types<'_, 'file> {
        Types {
            aliases: self.aliases,
            findings: &mut self.findings,
            expanding: BTreeSet::new(),
            named_at: None,
        }
    }

    fn judge_type(&mut self, written: &Type) {
        self.types().visit_type(written);
    }

    // its parameters, their patterns among them, its return and its bounds
    fn judge_signature(&mut self, signature: &Signature) {
        self.types().visit_signature(signature);
    }

    fn judge_fields(&mut self, (fields, line): (&Fields, usize)) {
        if let Fields::Unnamed(unnamed) = fields
            && unnamed.unnamed.len() > 1
        {
            self.findings.push(Finding {
                line,
                reason: UNNAMED,
            });
        }
    }

    fn judge_items(&mut self, items: &[Item]) {
        for item in items {
            self.judge_item(item);
        }
    }

    fn judge_item(&mut self, item: &Item) {
        match item {
            Item::Fn(function) if is_public(&function.vis) && !is_tests_alone(&function.attrs) => {
                self.judge_signature(&function.sig);
            }
            Item::Impl(implementation)
                if implementation.trait_.is_none() && !is_tests_alone(&implementation.attrs) =>
            {
                for inner in &implementation.items {
                    if let ImplItem::Fn(function) = inner
                        && is_public(&function.vis)
                        && !is_tests_alone(&function.attrs)
                    {
                        self.judge_signature(&function.sig);
                    } else if let ImplItem::Const(constant) = inner
                        && is_public(&constant.vis)
                    {
                        self.judge_type(&constant.ty);
                    }
                }
            }
            Item::Trait(declared) if is_public(&declared.vis) => {
                for inner in &declared.items {
                    if let TraitItem::Fn(function) = inner {
                        self.judge_signature(&function.sig);
                    } else if let TraitItem::Const(constant) = inner {
                        self.judge_type(&constant.ty);
                    }
                }
            }
            Item::Struct(declared) if is_public(&declared.vis) => {
                self.judge_fields((&declared.fields, declared.struct_token.span.start().line));

                for field in declared.fields.iter().filter(|field| is_public(&field.vis)) {
                    self.judge_type(&field.ty);
                }
            }
            Item::Enum(declared) if is_public(&declared.vis) => {
                for variant in &declared.variants {
                    self.judge_fields((&variant.fields, variant.ident.span().start().line));

                    for field in &variant.fields {
                        self.judge_type(&field.ty);
                    }
                }
            }
            Item::Type(alias) if is_public(&alias.vis) => self.judge_type(&alias.ty),
            Item::Const(constant) if is_public(&constant.vis) => self.judge_type(&constant.ty),
            Item::Static(declared) if is_public(&declared.vis) => self.judge_type(&declared.ty),
            Item::Mod(module) if module.ident != "testing" && !is_tests_alone(&module.attrs) => {
                if let Some((_, inner)) = &module.content {
                    self.judge_items(inner);
                }
            }
            Item::Const(_)
            | Item::Enum(_)
            | Item::ExternCrate(_)
            | Item::Fn(_)
            | Item::ForeignMod(_)
            | Item::Impl(_)
            | Item::Macro(_)
            | Item::Mod(_)
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

fn judged(file: &syn::File, aliases: &BTreeMap<String, &Type>) -> Vec<Finding> {
    let mut judge = Judge {
        aliases,
        findings: Vec::new(),
    };

    judge.judge_items(&file.items);
    judge.findings.sort_by_key(|finding| finding.line);
    judge.findings
}

/// What the rule refuses in `file`, each by its line, its own aliases expanded.
#[must_use]
pub fn tuples_of(file: &syn::File) -> Vec<Finding> {
    let mut aliases = BTreeMap::new();

    aliases_in(&file.items, &mut aliases);
    judged(file, &aliases)
}

// ── Over a crate ─────────────────────────────────────────────────────────────────────────────

// the files of the module `items` in `folder`, and of every module below it, the kit's and the
// tests' left out
fn files_below(
    (items, folder): (&[Item], &Path),
    found: &mut Vec<(PathBuf, syn::File)>,
) -> Result<(), String> {
    for item in items {
        let Item::Mod(module) = item else {
            continue;
        };

        if module.ident == "testing" || is_tests_alone(&module.attrs) {
            continue;
        }

        let below = folder.join(module.ident.to_string());

        if let Some((_, inner)) = &module.content {
            files_below((inner, &below), found)?;

            continue;
        }

        let path = folder.join(format!("{}.rs", module.ident));
        let text = std::fs::read_to_string(&path)
            .map_err(|error| format!("{} read: {error}", path.display()))?;
        let parsed = syn::parse_file(&text)
            .map_err(|error| format!("{} parsed: {error}", path.display()))?;

        files_below((&parsed.items, &below), found)?;
        found.push((path, parsed));
    }

    Ok(())
}

/// What the rule refuses in the library crate under `folder`, each as `path:line: reason`, every
/// alias of the crate's expanded.
///
/// # Errors
///
/// A file of the crate that does not read or does not parse.
pub fn crate_tuples_of(folder: &Path) -> Result<Vec<String>, String> {
    let lib = folder.join("src").join("lib.rs");
    let text = std::fs::read_to_string(&lib)
        .map_err(|error| format!("{} read: {error}", lib.display()))?;
    let parsed =
        syn::parse_file(&text).map_err(|error| format!("{} parsed: {error}", lib.display()))?;
    let mut files = Vec::new();

    files_below((&parsed.items, &folder.join("src")), &mut files)?;
    files.push((lib, parsed));

    let mut aliases = BTreeMap::new();

    for (_, file) in &files {
        aliases_in(&file.items, &mut aliases);
    }

    Ok(files
        .iter()
        .flat_map(|(path, file)| {
            judged(file, &aliases).into_iter().map(move |finding| {
                format!("{}:{}: {}", path.display(), finding.line, finding.reason)
            })
        })
        .collect())
}
