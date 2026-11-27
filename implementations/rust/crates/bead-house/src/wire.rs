//! The wire literal rule (decision 0057): in each module the table of the wire formats' names,
//! `tools/wire-names.tsv`, names for the Rust side, a number one of those formats' standards
//! defines is read by its name. A hex or binary integer literal stands only in a definition, and
//! outside one no `&`, `|` or `^`, compound forms included, takes an integer literal above 1. A
//! shift is left to review.
//!
//! A definition is a `const` or a `static` item of a module, an associated `const`, or an enum's
//! discriminant, with no function or closure between it and the literal. An item under
//! `#[cfg(test)]` is left out. A comment or a string is no code, as syn reads it. A macro's tokens
//! are read as the expressions they hold, a `matches!` as its expression and its pattern, and
//! token by token where they parse as neither, so that what the rule cannot read is refused.

use proc_macro2::{Spacing, TokenStream, TokenTree};
use syn::parse::ParseStream;
use syn::punctuated::Punctuated;
use syn::visit::Visit;
use syn::{
    Attribute, BinOp, Expr, ExprBinary, ExprClosure, ImplItem, ImplItemConst, ImplItemFn, Item,
    ItemConst, ItemFn, ItemMod, ItemStatic, Lit, LitInt, Macro, Meta, Pat, Token, TraitItemConst,
    TraitItemFn, Variant,
};

use crate::Finding;

#[cfg(test)]
mod tests;

const UNNAMED: &str =
    "a hex or binary literal outside a definition: a constant names it after its standard";

const OPERAND: &str =
    "a literal above 1 that a bitwise operator takes outside a definition: a constant names it";

// the table's cells, and the one that holds the Rust side's paths
const CELLS: usize = 7;
const RUST_CELL: usize = 6;

/// The modules the table of the wire formats' names, `table`, lists for the Rust side.
///
/// The holders' and the readers' alike, each path from the repository's root as the table writes
/// it, and each once, in the table's order.
///
/// # Errors
///
/// The row, by its line, that holds another number of cells than seven.
pub fn wire_modules_of(table: &str) -> Result<Vec<String>, String> {
    let mut modules: Vec<String> = Vec::new();

    for (index, row) in table.lines().enumerate() {
        if row.trim().is_empty() || row.starts_with('#') {
            continue;
        }

        let cells: Vec<&str> = row.split('\t').collect();
        let Some(cell) = cells.get(RUST_CELL).filter(|_| cells.len() == CELLS) else {
            return Err(format!(
                "line {}: {} cells, the table's are {CELLS}",
                index.saturating_add(1),
                cells.len()
            ));
        };

        // * a cell that opens with `-` is a reason whole, never read for a path
        if cell.starts_with('-') {
            continue;
        }

        for path in cell.split(", ") {
            let path = path.split('#').next().unwrap_or(path).trim();

            if !path.is_empty() && !modules.iter().any(|module| module == path) {
                modules.push(path.to_owned());
            }
        }
    }

    Ok(modules)
}

// where a literal stands: of a module, in a definition, or in code, a function's or a closure's
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Scope {
    Module,
    Definition,
    Code,
}

#[derive(Debug, Default)]
struct Rule {
    findings: Vec<Finding>,
    scopes: Vec<Scope>,
}

// a `matches!`'s tokens: its expression, its pattern, and its guard
struct Matched {
    scrutinee: Expr,
    pattern: Pat,
    guard: Option<Expr>,
}

impl Rule {
    fn scope(&self) -> Scope {
        self.scopes.last().copied().unwrap_or(Scope::Module)
    }

    fn is_defining(&self) -> bool {
        self.scope() == Scope::Definition
    }

    // what a definition opened here is: code still, within a function or a closure
    fn defining(&self) -> Scope {
        if self.scope() == Scope::Code {
            Scope::Code
        } else {
            Scope::Definition
        }
    }

    fn within<F: FnOnce(&mut Self)>(&mut self, scope: Scope, visit: F) {
        self.scopes.push(scope);
        visit(self);
        self.scopes.pop();
    }

    fn refuse(&mut self, line: usize, reason: &'static str) {
        self.findings.push(Finding { line, reason });
    }

    // a literal of a macro's tokens that parse as no expression, beside the trees around it
    fn scan(&mut self, tokens: TokenStream) {
        let trees: Vec<TokenTree> = tokens.into_iter().collect();

        for (index, tree) in trees.iter().enumerate() {
            match tree {
                TokenTree::Group(group) => self.scan(group.stream()),
                TokenTree::Literal(_) => {
                    let Ok(Lit::Int(literal)) = syn::parse2::<Lit>(TokenStream::from(tree.clone()))
                    else {
                        continue;
                    };

                    if self.is_defining() {
                        continue;
                    }

                    if is_hex_or_binary(&literal) {
                        self.refuse(line_of(&literal), UNNAMED);
                    } else if is_above_one(&literal) && is_beside_bitwise(&trees, index) {
                        self.refuse(line_of(&literal), OPERAND);
                    }
                }
                TokenTree::Ident(_) | TokenTree::Punct(_) => {}
            }
        }
    }
}

fn line_of(literal: &LitInt) -> usize {
    literal.span().start().line
}

// ! Rust writes a radix's prefix in lowercase alone: `0X` and `0B` are no literal
fn is_hex_or_binary(literal: &LitInt) -> bool {
    let written = literal.to_string();

    written.starts_with("0x") || written.starts_with("0b")
}

// * a literal too large to read counts as above 1, so that what is misread is refused
fn is_above_one(literal: &LitInt) -> bool {
    literal
        .base10_parse::<u128>()
        .map_or(true, |value| value > 1)
}

fn is_bitwise(operator: &BinOp) -> bool {
    matches!(
        operator,
        BinOp::BitAnd(_)
            | BinOp::BitOr(_)
            | BinOp::BitXor(_)
            | BinOp::BitAndAssign(_)
            | BinOp::BitOrAssign(_)
            | BinOp::BitXorAssign(_)
    )
}

// the literal an operand is, under parentheses, a group or a cast
fn literal_of(operand: &Expr) -> Option<&LitInt> {
    if let Expr::Lit(literal) = operand
        && let Lit::Int(integer) = &literal.lit
    {
        return Some(integer);
    }

    if let Expr::Paren(inner) = operand {
        return literal_of(&inner.expr);
    }

    if let Expr::Group(inner) = operand {
        return literal_of(&inner.expr);
    }

    if let Expr::Cast(cast) = operand {
        return literal_of(&cast.expr);
    }

    None
}

// whether a tree, a punctuation, is a bitwise operator: `^`, or a `&` or a `|` no other one of its
// kind doubles, as `&&` and `||` do
fn is_bitwise_punct(trees: &[TokenTree], index: usize) -> bool {
    let punct_at = |at: Option<usize>| match at.and_then(|at| trees.get(at)) {
        Some(TokenTree::Punct(punct)) => Some((punct.as_char(), punct.spacing())),
        Some(TokenTree::Group(_) | TokenTree::Ident(_) | TokenTree::Literal(_)) | None => None,
    };

    match punct_at(Some(index)) {
        Some(('^', _)) => true,
        Some((character @ ('&' | '|'), spacing)) => {
            let doubled_before = punct_at(index.checked_sub(1))
                .is_some_and(|(before, joint)| before == character && joint == Spacing::Joint);
            let doubled_after = spacing == Spacing::Joint
                && punct_at(index.checked_add(1)).is_some_and(|(after, _)| after == character);

            !doubled_before && !doubled_after
        }
        Some(_) | None => false,
    }
}

// whether the tree at `index` stands beside a bitwise operator, before or after it
fn is_beside_bitwise(trees: &[TokenTree], index: usize) -> bool {
    index
        .checked_sub(1)
        .is_some_and(|before| is_bitwise_punct(trees, before))
        || index
            .checked_add(1)
            .is_some_and(|after| is_bitwise_punct(trees, after))
}

// whether a `cfg` keeps what it marks to the tests, `#[cfg(test)]` exactly
fn is_tests_alone(attributes: &[Attribute]) -> bool {
    attributes.iter().any(|attribute| {
        attribute.path().is_ident("cfg")
            && matches!(&attribute.meta, Meta::List(list) if list.tokens.to_string() == "test")
    })
}

fn attributes_of(item: &Item) -> &[Attribute] {
    match item {
        Item::Const(item) => &item.attrs,
        Item::Enum(item) => &item.attrs,
        Item::Fn(item) => &item.attrs,
        Item::Impl(item) => &item.attrs,
        Item::Macro(item) => &item.attrs,
        Item::Mod(item) => &item.attrs,
        Item::Static(item) => &item.attrs,
        Item::Struct(item) => &item.attrs,
        Item::Trait(item) => &item.attrs,
        Item::Type(item) => &item.attrs,
        Item::Union(item) => &item.attrs,
        Item::Use(item) => &item.attrs,
        Item::ExternCrate(item) => &item.attrs,
        Item::ForeignMod(item) => &item.attrs,
        Item::TraitAlias(item) => &item.attrs,
        Item::Verbatim(_) | _ => &[],
    }
}

fn impl_attributes_of(item: &ImplItem) -> &[Attribute] {
    match item {
        ImplItem::Const(item) => &item.attrs,
        ImplItem::Fn(item) => &item.attrs,
        ImplItem::Type(item) => &item.attrs,
        ImplItem::Macro(item) => &item.attrs,
        ImplItem::Verbatim(_) | _ => &[],
    }
}

// the names of the macros whose tokens are an expression, then a pattern and its guard
fn is_matches(called: &Macro) -> bool {
    called.path.segments.last().is_some_and(|segment| {
        segment.ident == "matches"
            || segment.ident == "assert_matches"
            || segment.ident == "debug_assert_matches"
    })
}

fn matched(input: ParseStream<'_>) -> syn::Result<Matched> {
    let scrutinee: Expr = input.parse()?;

    input.parse::<Token![,]>()?;

    let pattern = Pat::parse_multi_with_leading_vert(input)?;
    let guard = if input.peek(Token![if]) {
        input.parse::<Token![if]>()?;

        Some(input.parse::<Expr>()?)
    } else {
        None
    };

    // what may follow: a trailing comma, then an assertion's message
    if input.peek(Token![,]) {
        input.parse::<Token![,]>()?;
        Punctuated::<Expr, Token![,]>::parse_terminated(input)?;
    }

    Ok(Matched {
        scrutinee,
        pattern,
        guard,
    })
}

impl<'ast> Visit<'ast> for Rule {
    fn visit_item(&mut self, item: &'ast Item) {
        if !is_tests_alone(attributes_of(item)) {
            syn::visit::visit_item(self, item);
        }
    }

    fn visit_impl_item(&mut self, item: &'ast ImplItem) {
        if !is_tests_alone(impl_attributes_of(item)) {
            syn::visit::visit_impl_item(self, item);
        }
    }

    fn visit_item_mod(&mut self, item: &'ast ItemMod) {
        self.within(Scope::Module, |rule| syn::visit::visit_item_mod(rule, item));
    }

    fn visit_item_const(&mut self, item: &'ast ItemConst) {
        let scope = self.defining();

        self.within(scope, |rule| syn::visit::visit_item_const(rule, item));
    }

    fn visit_item_static(&mut self, item: &'ast ItemStatic) {
        let scope = self.defining();

        self.within(scope, |rule| syn::visit::visit_item_static(rule, item));
    }

    fn visit_impl_item_const(&mut self, item: &'ast ImplItemConst) {
        let scope = self.defining();

        self.within(scope, |rule| syn::visit::visit_impl_item_const(rule, item));
    }

    fn visit_trait_item_const(&mut self, item: &'ast TraitItemConst) {
        let scope = self.defining();

        self.within(scope, |rule| {
            syn::visit::visit_trait_item_const(rule, item);
        });
    }

    fn visit_variant(&mut self, variant: &'ast Variant) {
        for attribute in &variant.attrs {
            self.visit_attribute(attribute);
        }

        self.visit_ident(&variant.ident);
        self.visit_fields(&variant.fields);

        if let Some((_, discriminant)) = &variant.discriminant {
            let scope = self.defining();

            self.within(scope, |rule| rule.visit_expr(discriminant));
        }
    }

    fn visit_item_fn(&mut self, item: &'ast ItemFn) {
        self.within(Scope::Code, |rule| syn::visit::visit_item_fn(rule, item));
    }

    fn visit_impl_item_fn(&mut self, item: &'ast ImplItemFn) {
        self.within(Scope::Code, |rule| {
            syn::visit::visit_impl_item_fn(rule, item);
        });
    }

    fn visit_trait_item_fn(&mut self, item: &'ast TraitItemFn) {
        self.within(Scope::Code, |rule| {
            syn::visit::visit_trait_item_fn(rule, item);
        });
    }

    fn visit_expr_closure(&mut self, closure: &'ast ExprClosure) {
        self.within(Scope::Code, |rule| {
            syn::visit::visit_expr_closure(rule, closure);
        });
    }

    fn visit_expr_binary(&mut self, binary: &'ast ExprBinary) {
        if !self.is_defining() && is_bitwise(&binary.op) {
            for operand in [&*binary.left, &*binary.right] {
                if let Some(literal) = literal_of(operand).filter(|literal| is_above_one(literal)) {
                    self.refuse(line_of(literal), OPERAND);
                }
            }
        }

        syn::visit::visit_expr_binary(self, binary);
    }

    fn visit_lit_int(&mut self, literal: &'ast LitInt) {
        if !self.is_defining() && is_hex_or_binary(literal) {
            self.refuse(line_of(literal), UNNAMED);
        }
    }

    // * a macro's tokens, which syn leaves unread, read as what they hold; the expressions so parsed
    // are the macro's own, visited at once
    fn visit_macro(&mut self, called: &'ast Macro) {
        if is_matches(called)
            && let Ok(matched) = called.parse_body_with(matched)
        {
            <Self as Visit<'_>>::visit_expr(self, &matched.scrutinee);
            <Self as Visit<'_>>::visit_pat(self, &matched.pattern);

            if let Some(guard) = &matched.guard {
                <Self as Visit<'_>>::visit_expr(self, guard);
            }

            return;
        }

        if let Ok(arguments) =
            called.parse_body_with(Punctuated::<Expr, Token![,]>::parse_terminated)
        {
            for argument in &arguments {
                <Self as Visit<'_>>::visit_expr(self, argument);
            }

            return;
        }

        self.scan(called.tokens.clone());
    }
}

/// Each literal of `file` the wire literal rule refuses, by its line: a hex or binary integer
/// literal outside a definition, and an integer literal above 1 that a bitwise operator takes
/// outside one.
#[must_use]
pub fn wire_literals_of(file: &syn::File) -> Vec<Finding> {
    let mut rule = Rule::default();

    rule.visit_file(file);
    rule.findings.sort_by_key(|finding| finding.line);
    rule.findings
}
