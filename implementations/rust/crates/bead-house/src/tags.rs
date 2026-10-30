//! The comment tags of CLAUDE.md, as Better Comments shows them: `!`, `?`, `TODO` and `*` open a
//! plain comment alone, and a doc comment carries none. A doc comment is what rustc's tokenizer
//! reads as one — `///` and `/** */` outside an item, `//!` and `/*! */` within one — so `//!` is
//! never the `!` tag, and `////` or `/***` is a plain comment.

use crate::Finding;

/// What a comment is, as rustc's tokenizer reads it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum CommentKind {
    /// A comment the compiler drops.
    Plain,
    /// A doc comment of the item that follows it: `///`, `/** */`.
    OuterDoc,
    /// A doc comment of the item it is within: `//!`, `/*! */`.
    InnerDoc,
}

/// A comment of a source: its line, its kind, and its text after its marker.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Comment {
    /// Its first line, from 1.
    pub line: usize,
    /// Its kind.
    pub kind: CommentKind,
    /// Its text after its marker.
    pub text: String,
}

// a tag, as a comment opens with it
const TAGS: [&str; 4] = ["! ", "? ", "TODO", "* "];

const DOC_TAGGED: &str = "a doc comment carries no tag: a tag opens a plain comment alone";

fn is_identifier(character: char) -> bool {
    character.is_alphanumeric() || character == '_'
}

// a scanner of a source's characters, by index
struct Scanner {
    characters: Vec<char>,
    at: usize,
    line: usize,
}

impl Scanner {
    fn peek(&self, ahead: usize) -> Option<char> {
        self.characters.get(self.at.saturating_add(ahead)).copied()
    }

    fn before(&self, behind: usize) -> Option<char> {
        self.at
            .checked_sub(behind)
            .and_then(|index| self.characters.get(index).copied())
    }

    fn advance(&mut self) -> Option<char> {
        let character = self.peek(0)?;

        if character == '\n' {
            self.line = self.line.saturating_add(1);
        }

        self.at = self.at.saturating_add(1);

        Some(character)
    }

    // the hashes of a raw string whose quote this is: `r`, `br` or `cr`, then as many `#`
    fn raw_hashes(&self) -> Option<usize> {
        let mut hashes = 0_usize;

        while self.before(hashes.saturating_add(1)) == Some('#') {
            hashes = hashes.saturating_add(1);
        }

        let r = hashes.saturating_add(1);

        if self.before(r) != Some('r') {
            return None;
        }

        let prefix = self.before(r.saturating_add(1));
        let is_alone = match prefix {
            Some('b' | 'c') => !self.before(r.saturating_add(2)).is_some_and(is_identifier),
            Some(other) => !is_identifier(other),
            None => true,
        };

        is_alone.then_some(hashes)
    }

    fn skip_string(&mut self) {
        let raw = self.raw_hashes();

        self.advance();

        while let Some(character) = self.advance() {
            match (character, raw) {
                ('\\', None) => {
                    self.advance();
                }
                ('"', None) => return,
                ('"', Some(hashes)) if (0..hashes).all(|offset| self.peek(offset) == Some('#')) => {
                    for _ in 0..hashes {
                        self.advance();
                    }

                    return;
                }
                _ => {}
            }
        }
    }

    // a character literal, or a lifetime or a label, which ends at no quote
    fn skip_quote(&mut self) {
        self.advance();

        if self.peek(0) == Some('\\') {
            while let Some(character) = self.advance() {
                if character == '\'' {
                    return;
                }
            }
        } else if self.peek(1) == Some('\'') {
            self.advance();
            self.advance();
        }
    }

    fn line_comment(&mut self) -> Comment {
        let line = self.line;
        let mut text = String::new();

        while let Some(character) = self.peek(0) {
            if character == '\n' {
                break;
            }

            text.push(character);
            self.advance();
        }

        // `///` but not `////`, `//!`
        let (kind, marker) = if text.starts_with("///") && !text.starts_with("////") {
            (CommentKind::OuterDoc, 3)
        } else if text.starts_with("//!") {
            (CommentKind::InnerDoc, 3)
        } else {
            (CommentKind::Plain, 2)
        };

        Comment {
            line,
            kind,
            text: text.chars().skip(marker).collect(),
        }
    }

    fn block_comment(&mut self) -> Comment {
        let line = self.line;
        let mut text = String::new();
        let mut depth = 0_usize;

        while let Some(character) = self.peek(0) {
            if character == '/' && self.peek(1) == Some('*') {
                depth = depth.saturating_add(1);
                text.push_str("/*");
                self.advance();
                self.advance();
            } else if character == '*' && self.peek(1) == Some('/') {
                depth = depth.saturating_sub(1);
                text.push_str("*/");
                self.advance();
                self.advance();

                if depth == 0 {
                    break;
                }
            } else {
                text.push(character);
                self.advance();
            }
        }

        // `/**` but not `/***` nor `/**/`, `/*!`
        let kind =
            if text.starts_with("/**") && !text.starts_with("/***") && !text.starts_with("/**/") {
                CommentKind::OuterDoc
            } else if text.starts_with("/*!") {
                CommentKind::InnerDoc
            } else {
                CommentKind::Plain
            };
        let marker = if kind == CommentKind::Plain { 2 } else { 3 };

        Comment {
            line,
            kind,
            text: text.chars().skip(marker).collect(),
        }
    }
}

/// Every comment of `source`, in its order, as rustc's tokenizer tells a comment from a string, a
/// character and a lifetime.
#[must_use]
pub fn comments_of(source: &str) -> Vec<Comment> {
    let mut scanner = Scanner {
        characters: source.chars().collect(),
        at: 0,
        line: 1,
    };
    let mut comments = Vec::new();

    while let Some(character) = scanner.peek(0) {
        match (character, scanner.peek(1)) {
            ('/', Some('/')) => comments.push(scanner.line_comment()),
            ('/', Some('*')) => comments.push(scanner.block_comment()),
            ('"', _) => scanner.skip_string(),
            ('\'', _) => scanner.skip_quote(),
            _ => {
                scanner.advance();
            }
        }
    }

    comments
}

/// What the comment tags refuse in `source`, each by its line: a doc comment that opens with a
/// tag.
#[must_use]
pub fn tags_of(source: &str) -> Vec<Finding> {
    comments_of(source)
        .into_iter()
        .filter(|comment| comment.kind != CommentKind::Plain)
        .filter(|comment| {
            let opening = comment.text.strip_prefix(' ').unwrap_or(&comment.text);

            TAGS.iter().any(|tag| opening.starts_with(tag)) || ["!", "?", "*"].contains(&opening)
        })
        .map(|comment| Finding {
            line: comment.line,
            reason: DOC_TAGGED,
        })
        .collect()
}
