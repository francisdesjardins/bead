//! Bead's setting of Buffa's generator on the Rust side (decision 0044), for a build script: the
//! code of a `proto` file as `bead_protobuf`'s codec reads it, generated from the
//! `FileDescriptorSet` protoc writes at its pin (`builder/protoc.json`), never by calling protoc.
//!
//! - **Views**, which the reader decodes and walks for a field protobuf requires before it takes
//!   the owned message (spec 17.9.7), since a view's presence is the wire's.
//! - **Reflection by vtable**, which the records check and the required walk read by descriptor.
//! - **Unknown fields kept**, and `MessageSet` allowed, which protobuf's own test messages hold.
//! - **Every repeated or map field of a closed enum opened**, read from the set's own
//!   descriptors: Buffa follows protobuf's Enum Behavior, which sets such an item or value of a
//!   number the enum does not declare among the unknown fields, where both other sides keep it as
//!   the item or the value it is (the leveled row of `docs/support.md`). A singular field stays
//!   closed, its undeclared number set aside (17.9.8).
//!
//! ```no_run
//! use std::path::Path;
//!
//! # fn main() -> Result<(), Box<dyn std::error::Error>> {
//! bead_protobuf_build::config_of(Path::new("proto/service.binpb"), &["service.proto"])?
//!     .include_file("_include.rs")
//!     .compile()?;
//! # Ok(())
//! # }
//! ```

use std::error::Error;
use std::fs;
use std::path::Path;

use buffa::editions::EnumType;
use buffa_descriptor::{DescriptorPool, FieldKind, SingularKind};

/// Buffa's generator, which [`config_of`] sets, for a build script to name its include file, its
/// output and any setting of its own before it compiles.
pub use buffa_build::Config;

#[cfg(test)]
mod tests;

/// Buffa's generator of `files`, among the set protoc wrote at `set`, set as Bead's codec reads
/// their messages.
///
/// # Errors
///
/// The set unread, or no `FileDescriptorSet` whose references resolve.
pub fn config_of(set: &Path, files: &[&str]) -> Result<Config, Box<dyn Error>> {
    let pool = DescriptorPool::decode(&fs::read(set)?)?;

    Ok(Config::new()
        .descriptor_set(set)
        .files(files)
        .generate_views(true)
        .generate_reflection(true)
        .reflect_mode(buffa_build::ReflectMode::VTable)
        .preserve_unknown_fields(true)
        .allow_message_set(true)
        .open_enums_in(&opened_of(&pool, files)))
}

/// The fields of `files`' messages the generator opens, each by its path as Buffa names one,
/// `.package.Message.field`: every repeated field whose item, and every map whose value, is of a
/// closed enum.
#[must_use]
pub fn opened_of(pool: &DescriptorPool, files: &[&str]) -> Vec<String> {
    let mut opened = Vec::new();

    for message in pool.messages() {
        let is_generated = pool
            .file_containing_symbol(message.full_name())
            .and_then(|file| file.name.as_deref())
            .is_some_and(|name| files.contains(&name));

        if !is_generated {
            continue;
        }

        for field in message.fields() {
            let holds_enum = matches!(
                field.kind(),
                FieldKind::List(SingularKind::Enum(_))
                    | FieldKind::Map {
                        value: SingularKind::Enum(_),
                        ..
                    }
            );

            if holds_enum && field.enum_type() == Some(EnumType::Closed) {
                opened.push(format!(".{}.{}", message.full_name(), field.name()));
            }
        }
    }

    opened
}
