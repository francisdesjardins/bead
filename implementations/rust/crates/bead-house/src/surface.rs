//! Each library crate's public surface, pinned to its list (decision 0047, as 0044 holds it): every
//! item written `pub` — each one reachable, since the workspace denies `unreachable_pub` — with its
//! declaration, a function's signature, a struct's `pub` fields with their types, an enum's
//! variants, a trait's items, a constant's type, each inherent `impl`'s `pub` functions, and the
//! traits each type derives or implements, by name; the root's `pub use` names and paths, and
//! `internal` as a module of its own. Bodies are not pinned. The test kit, `testing`, behind its
//! feature, is left out by name, and so is what a `cfg` keeps to the tests.
//!
//! A declaration is read from its source's own text, between two of its tokens, then printed by its
//! tokens alone: a list does not move when the formatter or a comment does.

use std::collections::BTreeMap;
use std::fmt::Write as _;
use std::path::Path;

use proc_macro2::{Delimiter, LineColumn, Spacing, Span, TokenStream, TokenTree};
use syn::{
    Attribute, Fields, ImplItem, Item, ItemEnum, ItemFn, ItemImpl, ItemStruct, ItemTrait, Meta,
    Signature, TraitItem, Type, UseTree, Visibility,
};

// ── Printing a declaration ────────────────────────────────────────────────────────────────────

// one token of a declaration, flattened
enum Piece {
    Word(String),
    Punct(char, Spacing),
    Open(char),
    Close(char),
}

fn flatten(tokens: TokenStream, pieces: &mut Vec<Piece>) {
    let mut trees = tokens.into_iter().peekable();

    while let Some(tree) = trees.next() {
        match tree {
            TokenTree::Group(group) => {
                let (open, close) = match group.delimiter() {
                    Delimiter::Parenthesis => ('(', ')'),
                    Delimiter::Brace => ('{', '}'),
                    Delimiter::Bracket => ('[', ']'),
                    Delimiter::None => {
                        flatten(group.stream(), pieces);

                        continue;
                    }
                };

                pieces.push(Piece::Open(open));
                flatten(group.stream(), pieces);

                // a trailing comma is the formatter's, never the declaration's
                if matches!(pieces.last(), Some(Piece::Punct(',', _))) {
                    pieces.pop();
                }

                pieces.push(Piece::Close(close));
            }
            TokenTree::Punct(punct) => {
                // an attribute, a doc comment among them, is no part of a declaration
                let is_attribute = punct.as_char() == '#'
                    && matches!(trees.peek(), Some(TokenTree::Group(group)) if group.delimiter() == Delimiter::Bracket);

                if is_attribute {
                    trees.next();
                } else {
                    pieces.push(Piece::Punct(punct.as_char(), punct.spacing()));
                }
            }
            TokenTree::Ident(ident) => pieces.push(Piece::Word(ident.to_string())),
            TokenTree::Literal(literal) => pieces.push(Piece::Word(literal.to_string())),
        }
    }
}

// the words a parenthesis after them is spaced from
const SPACED_WORDS: [&str; 9] = [
    "mut", "dyn", "impl", "where", "as", "in", "const", "unsafe", "extern",
];

// whether a space stands between `before` and `after`; `closes` names the punctuation that
// `before` ends an operator of, `-` for `->`, `:` for `::`
fn spaced(before: &Piece, (after, closes): (&Piece, Option<char>)) -> bool {
    // braces hold their content apart, and nothing when empty
    if matches!(before, Piece::Open('{')) {
        return !matches!(after, Piece::Close('}'));
    }

    if matches!(after, Piece::Close('}')) {
        return true;
    }

    if matches!(before, Piece::Open(_))
        || matches!(after, Piece::Close(_) | Piece::Punct(',' | ';', _))
    {
        return false;
    }

    match before {
        // `->` and `=>` stand apart from what follows them
        Piece::Punct('>', _) if matches!(closes, Some('-' | '=')) => true,
        // `a: u32`, against a path's `::`
        Piece::Punct(':', Spacing::Alone) => closes != Some(':'),
        Piece::Punct(':' | '&' | '\'' | '<' | '*' | '?' | '!' | '-', Spacing::Joint)
        | Piece::Punct('&' | '\'' | '<' | '*' | '?' | '!', Spacing::Alone) => false,
        Piece::Punct('>', _) => matches!(
            after,
            Piece::Word(_) | Piece::Open('{') | Piece::Punct('-' | '=' | '+', _)
        ),
        Piece::Word(word) if matches!(after, Piece::Open('(')) => {
            SPACED_WORDS.contains(&word.as_str())
        }
        Piece::Close(_) if matches!(after, Piece::Open(_)) => false,
        Piece::Word(_) | Piece::Close(_) | Piece::Punct(..) | Piece::Open(_) => {
            !matches!(after, Piece::Punct(':' | '<' | '>', _))
        }
    }
}

// a declaration's tokens, printed as one line
fn printed(text: &str) -> String {
    let Ok(tokens) = text.parse::<TokenStream>() else {
        return text.split_whitespace().collect::<Vec<_>>().join(" ");
    };
    let mut pieces = Vec::new();
    let mut line = String::new();

    flatten(tokens, &mut pieces);

    for (index, piece) in pieces.iter().enumerate() {
        if let Some(before) = index.checked_sub(1).and_then(|before| pieces.get(before)) {
            // the punctuation `before` ends an operator of, joined to it
            let closes = index
                .checked_sub(2)
                .and_then(|two| pieces.get(two))
                .and_then(|two| {
                    if let (Piece::Punct(first, Spacing::Joint), Piece::Punct(..)) = (two, before) {
                        Some(*first)
                    } else {
                        None
                    }
                });

            if spaced(before, (piece, closes)) {
                line.push(' ');
            }
        }

        match piece {
            Piece::Word(word) => line.push_str(word),
            Piece::Punct(character, _) | Piece::Open(character) | Piece::Close(character) => {
                line.push(*character);
            }
        }
    }

    line
}

// a source's text, and where each of its lines starts
struct Source<'text> {
    text: &'text str,
    starts: Vec<usize>,
}

impl<'text> Source<'text> {
    fn new(text: &'text str) -> Self {
        let starts = core::iter::once(0)
            .chain(
                text.match_indices('\n')
                    .map(|(index, _)| index.saturating_add(1)),
            )
            .collect();

        Self { text, starts }
    }

    // the byte a line and a column in characters name
    fn offset(&self, at: LineColumn) -> usize {
        let Some(&start) = self.starts.get(at.line.saturating_sub(1)) else {
            return self.text.len();
        };
        let rest = self.text.get(start..).unwrap_or_default();

        rest.char_indices()
            .nth(at.column)
            .map_or(self.text.len(), |(index, _)| start.saturating_add(index))
    }

    // the declaration between the start of `from` and the start of `to`, printed
    fn between(&self, (from, to): (Span, Span)) -> String {
        let (start, end) = (self.offset(from.start()), self.offset(to.start()));

        printed(self.text.get(start..end).unwrap_or_default())
    }

    // the declaration from the start of `from` to the end of `to`, printed
    fn through(&self, (from, to): (Span, Span)) -> String {
        let (start, end) = (self.offset(from.start()), self.offset(to.end()));

        printed(self.text.get(start..end).unwrap_or_default())
    }
}

// ── Reading the items ─────────────────────────────────────────────────────────────────────────

fn is_public(visibility: &Visibility) -> bool {
    matches!(visibility, Visibility::Public(_))
}

// whether a `cfg` keeps the item to the tests, the kit's feature among them
fn is_tests_alone(attributes: &[Attribute]) -> bool {
    attributes.iter().any(|attribute| {
        attribute.path().is_ident("cfg")
            && matches!(&attribute.meta, Meta::List(list) if list.tokens.clone().into_iter().any(|tree| {
                matches!(&tree, TokenTree::Ident(ident) if ident == "test")
            }))
    })
}

// the features an item needs, as its `cfg` names them: none for the tests' own, which the list
// leaves out (decision 0049)
fn needs_of(attributes: &[Attribute]) -> String {
    let mut needs = String::new();

    for attribute in attributes {
        if attribute.path().is_ident("cfg")
            && !is_tests_alone(core::slice::from_ref(attribute))
            && let Meta::List(list) = &attribute.meta
        {
            write!(needs, " #[cfg({})]", printed(&list.tokens.to_string())).ok();
        }
    }

    needs
}

// the attributes a list names: `#[non_exhaustive]`, `#[doc(hidden)]` and the features it needs
fn marks_of(attributes: &[Attribute]) -> String {
    let mut marks = String::new();

    for attribute in attributes {
        if attribute.path().is_ident("non_exhaustive") {
            marks.push_str(" #[non_exhaustive]");
        } else if attribute.path().is_ident("doc")
            && matches!(&attribute.meta, Meta::List(list) if list.tokens.to_string() == "hidden")
        {
            marks.push_str(" #[doc(hidden)]");
        }
    }

    marks.push_str(&needs_of(attributes));
    marks
}

fn derived_of(attributes: &[Attribute]) -> Vec<String> {
    let mut names = Vec::new();

    for attribute in attributes {
        if attribute.path().is_ident("derive") {
            // a derive that does not parse derives nothing this list reads
            attribute
                .parse_nested_meta(|meta| {
                    if let Some(last) = meta.path.segments.last() {
                        names.push(last.ident.to_string());
                    }

                    Ok(())
                })
                .ok();
        }
    }

    names.sort();
    names
}

fn name_of(written: &Type) -> Option<String> {
    let Type::Path(path) = written else {
        return None;
    };

    path.path
        .segments
        .last()
        .map(|segment| segment.ident.to_string())
}

// a signature, from its `fn` to the token that ends it
fn signature_of(source: &Source<'_>, (signature, end): (&Signature, Span)) -> String {
    let mut said = String::new();

    if signature.constness.is_some() {
        said.push_str("const ");
    }

    if signature.asyncness.is_some() {
        said.push_str("async ");
    }

    said.push_str(&source.between((signature.fn_token.span, end)));
    said
}

// what each type's `impl`s say, by its name, over the whole crate
#[derive(Default)]
struct Implemented {
    traits: Vec<String>,
    functions: Vec<String>,
}

fn impl_of(
    source: &Source<'_>,
    (implementation, found): (&ItemImpl, &mut BTreeMap<String, Implemented>),
) {
    if is_tests_alone(&implementation.attrs) {
        return;
    }

    let Some(name) = name_of(&implementation.self_ty) else {
        return;
    };
    let entry = found.entry(name).or_default();

    if let Some((path, _)) = &implementation.trait_ {
        if let Some(last) = path.segments.last() {
            entry.traits.push(last.ident.to_string());
        }

        return;
    }

    for inner in &implementation.items {
        if let ImplItem::Fn(function) = inner
            && is_public(&function.vis)
            && !is_tests_alone(&function.attrs)
        {
            entry.functions.push(signature_of(
                source,
                (&function.sig, function.block.brace_token.span.open()),
            ));
        } else if let ImplItem::Const(constant) = inner
            && is_public(&constant.vis)
        {
            entry
                .functions
                .push(source.between((constant.const_token.span, constant.eq_token.span)));
        }
    }
}

// a module's items, as the list says them, and the `impl`s it holds
struct Module {
    path: String,
    lines: Vec<(String, Option<String>)>,
}

fn uses_of(tree: &UseTree, (prefix, said): (&str, &mut Vec<String>)) {
    if let UseTree::Path(path) = tree {
        uses_of(&path.tree, (&format!("{prefix}{}::", path.ident), said));
    } else if let UseTree::Name(name) = tree {
        said.push(format!("{prefix}{}", name.ident));
    } else if let UseTree::Rename(rename) = tree {
        said.push(format!("{prefix}{} as {}", rename.ident, rename.rename));
    } else if let UseTree::Glob(_) = tree {
        said.push(format!("{prefix}*"));
    } else if let UseTree::Group(group) = tree {
        for item in &group.items {
            uses_of(item, (prefix, said));
        }
    }
}

fn struct_of(source: &Source<'_>, declared: &ItemStruct) -> Vec<String> {
    let mut lines = Vec::new();
    let header = match &declared.fields {
        Fields::Named(fields) => {
            source.between((declared.struct_token.span, fields.brace_token.span.open()))
        }
        Fields::Unnamed(_) | Fields::Unit => declared.semi_token.as_ref().map_or_else(
            || printed(&format!("struct {}", declared.ident)),
            |semi| source.through((declared.struct_token.span, semi.span)),
        ),
    };

    lines.push(format!("{header}{}", marks_of(&declared.attrs)));

    if let Fields::Named(fields) = &declared.fields {
        for pair in fields.named.pairs() {
            let field = pair.value();
            let Some(ident) = &field.ident else {
                continue;
            };

            if !is_public(&field.vis) {
                continue;
            }

            let end = pair
                .punct()
                .map_or_else(|| fields.brace_token.span.close(), |comma| comma.span);

            lines.push(format!("  pub {}", source.between((ident.span(), end))));
        }
    }

    lines
}

fn enum_of(source: &Source<'_>, declared: &ItemEnum) -> Vec<String> {
    let mut lines = vec![format!(
        "{}{}",
        source.between((declared.enum_token.span, declared.brace_token.span.open())),
        marks_of(&declared.attrs)
    )];

    for pair in declared.variants.pairs() {
        let variant = pair.value();
        let end = pair
            .punct()
            .map_or_else(|| declared.brace_token.span.close(), |comma| comma.span);

        lines.push(format!(
            "  {}{}",
            source.between((variant.ident.span(), end)),
            marks_of(&variant.attrs)
        ));
    }

    lines
}

fn trait_of(source: &Source<'_>, declared: &ItemTrait) -> Vec<String> {
    let mut lines = vec![format!(
        "{}{}",
        source.between((declared.trait_token.span, declared.brace_token.span.open())),
        marks_of(&declared.attrs)
    )];

    for item in &declared.items {
        if let TraitItem::Fn(function) = item {
            let end = function.default.as_ref().map_or_else(
                || {
                    function
                        .semi_token
                        .as_ref()
                        .map_or(function.sig.fn_token.span, |semi| semi.span)
                },
                |block| block.brace_token.span.open(),
            );

            lines.push(format!("  {}", signature_of(source, (&function.sig, end))));
        } else if let TraitItem::Type(associated) = item {
            lines.push(format!(
                "  {}",
                source.between((associated.type_token.span, associated.semi_token.span))
            ));
        } else if let TraitItem::Const(constant) = item {
            let end = constant
                .default
                .as_ref()
                .map_or(constant.semi_token.span, |(eq, _)| eq.span);

            lines.push(format!(
                "  {}",
                source.between((constant.const_token.span, end))
            ));
        }
    }

    lines
}

fn function_of(source: &Source<'_>, function: &ItemFn) -> String {
    signature_of(
        source,
        (&function.sig, function.block.brace_token.span.open()),
    )
}

// the module of `items`, its path `path`, its folder `folder`, and every module below it
fn read_module(
    (items, path, folder, needs): (&[Item], &str, &Path, &str),
    (source, modules, implemented): (
        &Source<'_>,
        &mut Vec<Module>,
        &mut BTreeMap<String, Implemented>,
    ),
) -> Result<(), String> {
    let mut module = Module {
        path: path.to_owned(),
        lines: Vec::new(),
    };
    let mut below = Vec::new();

    for item in items {
        if let Item::Impl(implementation) = item {
            impl_of(source, (implementation, implemented));
        } else if let Item::Mod(declared) = item {
            // the test kit, behind its feature, is left out by name
            if is_tests_alone(&declared.attrs) || declared.ident == "testing" {
                continue;
            }

            if is_public(&declared.vis) {
                module.lines.push((
                    format!("mod {}{}", declared.ident, marks_of(&declared.attrs)),
                    None,
                ));
            }

            below.push(declared);
        } else if let Some(said) = item_of(source, item) {
            module.lines.extend(said);
        }
    }

    // * a module a feature holds marks each line it lists with it
    if !needs.is_empty() {
        for (line, _) in &mut module.lines {
            if !line.is_empty() {
                line.push_str(needs);
            }
        }
    }

    modules.push(module);

    for declared in below {
        let inner_path = format!("{path}::{}", declared.ident);
        let inner_needs = format!("{needs}{}", needs_of(&declared.attrs));

        if let Some((_, inner)) = &declared.content {
            read_module(
                (
                    inner,
                    &inner_path,
                    &folder.join(declared.ident.to_string()),
                    &inner_needs,
                ),
                (source, modules, implemented),
            )?;
        } else {
            let file = folder.join(format!("{}.rs", declared.ident));
            let text = std::fs::read_to_string(&file)
                .map_err(|error| format!("{} read: {error}", file.display()))?;
            let parsed = syn::parse_file(&text)
                .map_err(|error| format!("{} parsed: {error}", file.display()))?;
            let inner_source = Source::new(&text);

            read_module(
                (
                    &parsed.items,
                    &inner_path,
                    &folder.join(declared.ident.to_string()),
                    &inner_needs,
                ),
                (&inner_source, modules, implemented),
            )?;
        }
    }

    Ok(())
}

// what the list says of a public item that is no module and no `impl`, each line with the type
// its `impl`s are told under
fn item_of(source: &Source<'_>, item: &Item) -> Option<Vec<(String, Option<String>)>> {
    let lines = if let Item::Fn(function) = item {
        (is_public(&function.vis) && !is_tests_alone(&function.attrs))
            .then(|| vec![(function_of(source, function), None)])
    } else if let Item::Struct(declared) = item {
        (is_public(&declared.vis) && !is_tests_alone(&declared.attrs)).then(|| {
            let mut lines: Vec<(String, Option<String>)> = struct_of(source, declared)
                .into_iter()
                .map(|line| (line, None))
                .collect();

            lines.push((String::new(), Some(declared.ident.to_string())));
            lines.push((derives_line(&declared.attrs), None));
            lines
        })
    } else if let Item::Enum(declared) = item {
        (is_public(&declared.vis) && !is_tests_alone(&declared.attrs)).then(|| {
            let mut lines: Vec<(String, Option<String>)> = enum_of(source, declared)
                .into_iter()
                .map(|line| (line, None))
                .collect();

            lines.push((String::new(), Some(declared.ident.to_string())));
            lines.push((derives_line(&declared.attrs), None));
            lines
        })
    } else if let Item::Trait(declared) = item {
        (is_public(&declared.vis) && !is_tests_alone(&declared.attrs)).then(|| {
            trait_of(source, declared)
                .into_iter()
                .map(|line| (line, None))
                .collect()
        })
    } else if let Item::Const(constant) = item {
        (is_public(&constant.vis) && !is_tests_alone(&constant.attrs)).then(|| {
            vec![(
                source.between((constant.const_token.span, constant.eq_token.span)),
                None,
            )]
        })
    } else if let Item::Static(declared) = item {
        (is_public(&declared.vis) && !is_tests_alone(&declared.attrs)).then(|| {
            vec![(
                source.between((declared.static_token.span, declared.eq_token.span)),
                None,
            )]
        })
    } else if let Item::Type(alias) = item {
        (is_public(&alias.vis) && !is_tests_alone(&alias.attrs)).then(|| {
            vec![(
                source.between((alias.type_token.span, alias.semi_token.span)),
                None,
            )]
        })
    } else if let Item::Use(used) = item {
        (is_public(&used.vis) && !is_tests_alone(&used.attrs)).then(|| {
            let mut said = Vec::new();

            uses_of(&used.tree, ("", &mut said));

            said.into_iter()
                .map(|path| (format!("use {path}{}", needs_of(&used.attrs)), None))
                .collect()
        })
    } else {
        None
    };

    lines.filter(|lines| !lines.is_empty())
}

fn derives_line(attributes: &[Attribute]) -> String {
    let derived = derived_of(attributes);

    if derived.is_empty() {
        String::new()
    } else {
        format!("  derives {}", derived.join(", "))
    }
}

/// The public surface of the library crate under `folder`, as `crates/bead-house/surfaces/` holds it.
///
/// Each module by its path, then each public item of it with its members, in its source's order.
///
/// # Errors
///
/// A file of the crate that does not read or does not parse.
pub fn surface_of(folder: &Path) -> Result<String, String> {
    let lib = folder.join("src").join("lib.rs");
    let text = std::fs::read_to_string(&lib)
        .map_err(|error| format!("{} read: {error}", lib.display()))?;
    let parsed =
        syn::parse_file(&text).map_err(|error| format!("{} parsed: {error}", lib.display()))?;
    let source = Source::new(&text);
    let mut modules = Vec::new();
    let mut implemented = BTreeMap::new();

    read_module(
        (&parsed.items, "crate", &folder.join("src"), ""),
        (&source, &mut modules, &mut implemented),
    )?;

    let mut list = String::new();

    for module in modules.iter().filter(|module| !module.lines.is_empty()) {
        writeln!(list, "{}", module.path).ok();

        for (line, type_name) in &module.lines {
            if let Some(type_name) = type_name {
                let Some(found) = implemented.get_mut(type_name) else {
                    continue;
                };

                for function in &found.functions {
                    writeln!(list, "    {function}").ok();
                }

                found.traits.sort();
                found.traits.dedup();

                if !found.traits.is_empty() {
                    writeln!(list, "    implements {}", found.traits.join(", ")).ok();
                }
            } else if !line.is_empty() {
                writeln!(list, "  {line}").ok();
            }
        }
    }

    Ok(list)
}
