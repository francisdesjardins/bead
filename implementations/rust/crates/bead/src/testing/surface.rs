//! Compiles a consumer against the libraries beside the running test, checking the public surface:
//! what a crate of its own may write, and what its compiler refuses, by the refusal's code.
//!
//! The libraries are the rlibs cargo built for the test, in its `deps` folder. Where a library was
//! built more than once, for features apart, the one taken is the newest the libraries taken before
//! it name, else the newest: so the crates a consumer names are the ones that were built together.

use core::sync::atomic::{AtomicUsize, Ordering};
use std::collections::BTreeMap;
use std::ffi::OsStr;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::time::SystemTime;

use serde_json::Value;

static NEXT: AtomicUsize = AtomicUsize::new(0);

// the probe a consumer of the core alone first compiles
const PROBE: &str = "pub fn check(_: &bead::RouterServer, _: &bead::RequestResolverProps) {}";

/// How a [`Consumer`] is set.
#[derive(Debug, Clone, Default)]
#[non_exhaustive]
pub struct ConsumerOptions {
    /// The crates it names, each by its library's name, as `--extern` gives them: `bead` alone
    /// when none. A crate another of them depends on comes after it.
    pub crates: Option<Vec<String>>,
    /// The variables its compiler runs with, as a build script's `OUT_DIR`: none when none.
    pub environment: Option<BTreeMap<String, String>>,
    /// A source it compiles as it is made, the surface it stands on: a probe of the core's when
    /// none.
    pub probe: Option<String>,
}

/// What its compiler said of a source: whether it compiled, each diagnostic as rustc's JSON gives
/// it, and its whole output.
#[derive(Debug, Clone)]
#[non_exhaustive]
pub struct Compiled {
    /// Whether it compiled.
    pub succeeded: bool,
    /// Each diagnostic, as `--error-format json` writes it.
    pub diagnostics: Vec<Value>,
    /// Its standard error.
    pub stderr: String,
}

impl Compiled {
    /// The diagnostics of `level` (`error`, `warning`) whose code is `code`.
    #[must_use]
    pub fn of_code(&self, level: &str, code: &str) -> Vec<&Value> {
        self.diagnostics
            .iter()
            .filter(|diagnostic| {
                diagnostic.get("level").and_then(Value::as_str) == Some(level)
                    && diagnostic
                        .get("code")
                        .and_then(|code| code.get("code"))
                        .and_then(Value::as_str)
                        == Some(code)
            })
            .collect()
    }
}

/// A crate of its own, compiled against the libraries the test was built with.
#[derive(Debug)]
pub struct Consumer {
    directory: PathBuf,
    dependencies: PathBuf,
    libraries: Vec<Library>,
    environment: BTreeMap<String, String>,
}

// a library a consumer names: its name, and its rlib
#[derive(Debug, Clone)]
struct Library {
    name: String,
    path: PathBuf,
}

// the rlibs of `name` in `dependencies`, the newest first
fn candidates_of(dependencies: &Path, name: &str) -> Result<Vec<PathBuf>, String> {
    let prefix = format!("lib{name}-");
    let mut found: Vec<(SystemTime, PathBuf)> = Vec::new();

    for entry in fs::read_dir(dependencies)
        .map_err(|error| format!("the test's dependencies are unread: {error}"))?
    {
        let path = entry
            .map_err(|error| format!("an artifact is unread: {error}"))?
            .path();
        let is_rlib = path
            .extension()
            .and_then(OsStr::to_str)
            .is_some_and(|extension| extension.eq_ignore_ascii_case("rlib"));
        let is_named = path
            .file_name()
            .and_then(OsStr::to_str)
            .is_some_and(|file| file.starts_with(&prefix));

        if is_rlib && is_named {
            let modified = path
                .metadata()
                .and_then(|metadata| metadata.modified())
                .map_err(|error| format!("{} has no time: {error}", path.display()))?;

            found.push((modified, path));
        }
    }

    found.sort_by_key(|(modified, _)| core::cmp::Reverse(*modified));

    Ok(found.into_iter().map(|(_, path)| path).collect())
}

// the hash cargo gives an rlib's name, `-<hash>`, which a library built against it records as its
// dependency's
fn suffix_of(path: &Path) -> Option<String> {
    let stem = path.file_stem()?.to_str()?;

    stem.rfind('-')
        .and_then(|at| stem.get(at..))
        .map(str::to_owned)
}

// whether `haystack` holds `needle`
fn holds(haystack: &[u8], needle: &[u8]) -> bool {
    !needle.is_empty()
        && haystack
            .windows(needle.len())
            .any(|window| window == needle)
}

// each crate's rlib: the newest one a library taken before names, else the newest
fn libraries_of(dependencies: &Path, crates: &[String]) -> Result<Vec<Library>, String> {
    let mut taken: Vec<Library> = Vec::new();
    let mut read: Vec<Vec<u8>> = Vec::new();

    for name in crates {
        let candidates = candidates_of(dependencies, name)?;
        let named = candidates.iter().find(|candidate| {
            suffix_of(candidate)
                .is_some_and(|suffix| read.iter().any(|bytes| holds(bytes, suffix.as_bytes())))
        });
        let path = named
            .or_else(|| candidates.first())
            .ok_or_else(|| format!("no library {name} beside the test"))?
            .clone();

        read.push(
            fs::read(&path).map_err(|error| format!("{} is unread: {error}", path.display()))?,
        );
        taken.push(Library {
            name: name.clone(),
            path,
        });
    }

    Ok(taken)
}

impl Consumer {
    /// A consumer set by `options`, its probe compiled.
    ///
    /// # Errors
    ///
    /// The running test's folder unread, a library it names missing, or its probe refused, in the
    /// compiler's words.
    pub fn of(options: &ConsumerOptions) -> Result<Self, String> {
        let executable = std::env::current_exe()
            .map_err(|error| format!("the running test has no path: {error}"))?;
        let dependencies = executable
            .parent()
            .ok_or("the running test has no folder")?
            .to_owned();
        let crates = options
            .crates
            .clone()
            .unwrap_or_else(|| vec!["bead".to_owned()]);
        let libraries = libraries_of(&dependencies, &crates)?;
        let directory = dependencies.join(format!(
            "bead-surface-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));

        fs::create_dir_all(&directory)
            .map_err(|error| format!("no private folder in the test's target: {error}"))?;

        let consumer = Self {
            directory,
            dependencies,
            libraries,
            environment: options.environment.clone().unwrap_or_default(),
        };
        let probe = consumer.compiled(options.probe.as_deref().unwrap_or(PROBE))?;

        if !probe.succeeded {
            return Err(format!("its probe is refused:\n{}", probe.stderr));
        }

        Ok(consumer)
    }

    /// What its compiler says of `source`, a library crate of the 2024 edition.
    ///
    /// # Errors
    ///
    /// The source unwritten, or the compiler that does not run.
    pub fn compiled(&self, source: &str) -> Result<Compiled, String> {
        let input = self.directory.join("consumer.rs");

        fs::write(&input, source).map_err(|error| format!("the source is unwritten: {error}"))?;

        let mut command = Command::new(std::env::var_os("RUSTC").unwrap_or_else(|| "rustc".into()));

        command.args([
            "--crate-name",
            "bead_surface",
            "--crate-type",
            "lib",
            "--edition",
            "2024",
            "--emit",
            "metadata",
            "--error-format",
            "json",
        ]);

        for library in &self.libraries {
            command
                .arg("--extern")
                .arg(format!("{}={}", library.name, library.path.display()));
        }

        command
            .arg("-L")
            .arg(format!("dependency={}", self.dependencies.display()))
            .arg("-o")
            .arg(self.directory.join("consumer.rmeta"))
            .arg(input)
            .envs(&self.environment);

        let output: Output = command
            .output()
            .map_err(|error| format!("the pinned compiler does not run: {error}"))?;
        let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
        let diagnostics = stderr
            .lines()
            .filter_map(|line| serde_json::from_str::<Value>(line).ok())
            .collect();

        Ok(Compiled {
            succeeded: output.status.success(),
            diagnostics,
            stderr,
        })
    }

    /// Whether its compiler takes `source`.
    ///
    /// # Errors
    ///
    /// The source refused, in the compiler's words.
    pub fn takes(&self, source: &str) -> Result<(), String> {
        let compiled = self.compiled(source)?;

        if compiled.succeeded {
            Ok(())
        } else {
            Err(format!("{source}\n{}", compiled.stderr))
        }
    }

    /// Whether its compiler refuses `source` with an error of `code` whose message holds `detail`.
    ///
    /// # Errors
    ///
    /// The source taken, or refused otherwise, in the compiler's words.
    pub fn refusal(&self, source: &str, refusal: &Refusal) -> Result<(), String> {
        let compiled = self.compiled(source)?;

        if compiled.succeeded {
            return Err(format!("the compiler accepts {source}"));
        }

        let is_refused = compiled.of_code("error", refusal.code).iter().any(|error| {
            error
                .get("message")
                .and_then(Value::as_str)
                .is_some_and(|message| message.contains(refusal.detail))
        });

        if is_refused {
            Ok(())
        } else {
            Err(format!("{source}\n{}", compiled.stderr))
        }
    }

    // the consumer of the core alone, as the crate's own tests take it
    #[cfg(test)]
    pub(crate) fn new() -> Self {
        Self::of(&ConsumerOptions::default()).expect("a consumer of the core")
    }

    #[cfg(test)]
    pub(crate) fn accepts(&self, source: &str) {
        let taken = self.takes(source);

        assert!(taken.is_ok(), "{}", taken.err().unwrap_or_default());
    }

    #[cfg(test)]
    pub(crate) fn refuses(&self, source: &str, (code, detail): (&str, &str)) {
        let refused = self.refusal(source, &Refusal { code, detail });

        assert!(refused.is_ok(), "{}", refused.err().unwrap_or_default());
    }
}

/// A refusal its compiler is expected to give: its error's code, and a part of its message.
#[derive(Debug, Clone, Copy)]
pub struct Refusal<'a> {
    /// The error's code, `E0599`.
    pub code: &'a str,
    /// A part of its message.
    pub detail: &'a str,
}

impl Drop for Consumer {
    fn drop(&mut self) {
        // a folder left behind is the target's, which cargo cleans
        fs::remove_dir_all(&self.directory).ok();
    }
}
