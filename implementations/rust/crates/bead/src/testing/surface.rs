//! Compiles a consumer against the library beside the running test, checking the public surface.

use core::sync::atomic::{AtomicUsize, Ordering};
use std::path::PathBuf;
use std::process::Command;

static NEXT: AtomicUsize = AtomicUsize::new(0);

pub(crate) struct Consumer {
    directory: PathBuf,
    dependencies: PathBuf,
    library: PathBuf,
}

impl Consumer {
    pub(crate) fn new() -> Self {
        let executable = std::env::current_exe().expect("the running test's path");
        let dependencies = executable
            .parent()
            .expect("the test's dependencies")
            .to_owned();
        let library = std::fs::read_dir(&dependencies)
            .expect("the test's dependencies are readable")
            .map(|entry| entry.expect("an artifact").path())
            .filter(|path| {
                path.file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.starts_with("libbead-"))
                    && path
                        .extension()
                        .and_then(std::ffi::OsStr::to_str)
                        .is_some_and(|extension| extension.eq_ignore_ascii_case("rlib"))
            })
            .max_by_key(|path| {
                path.metadata()
                    .expect("the artifact's metadata")
                    .modified()
                    .expect("the artifact's modification time")
            })
            .expect("the library built for the tests");
        let directory = dependencies.join(format!(
            "bead-surface-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&directory).expect("a private folder in the test's target");
        let consumer = Self {
            directory,
            dependencies,
            library,
        };
        consumer.accepts("pub fn check(_: &bead::RouterServer, _: &bead::RequestResolverProps) {}");
        consumer
    }

    fn compile(&self, source: &str) -> std::process::Output {
        let input = self.directory.join("consumer.rs");
        std::fs::write(&input, source).expect("the consumer's source is written");
        Command::new(std::env::var_os("RUSTC").unwrap_or_else(|| "rustc".into()))
            .args([
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
            ])
            .arg("--extern")
            .arg(format!("bead={}", self.library.display()))
            .arg("-L")
            .arg(format!("dependency={}", self.dependencies.display()))
            .arg("-o")
            .arg(self.directory.join("consumer.rmeta"))
            .arg(input)
            .output()
            .expect("the pinned compiler runs")
    }

    pub(crate) fn accepts(&self, source: &str) {
        let output = self.compile(source);
        assert!(
            output.status.success(),
            "{source}\n{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    pub(crate) fn refuses(&self, source: &str, (code, detail): (&str, &str)) {
        let output = self.compile(source);
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(!output.status.success(), "the compiler accepts {source}");
        let errors = stderr
            .lines()
            .filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
            .collect::<Vec<_>>();
        assert!(
            errors.iter().any(|error| error["level"] == "error"
                && error["code"]["code"] == code
                && error["message"]
                    .as_str()
                    .is_some_and(|message| message.contains(detail))),
            "{source}\n{stderr}"
        );
    }
}

impl Drop for Consumer {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.directory).expect("the private consumer folder is removed");
    }
}
