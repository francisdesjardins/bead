//! The house's checks over the Rust side, and over the cases of each verdict: every function's
//! parameters, every doc comment's opening, and every member's lints.

use std::fs;
use std::path::{Path, PathBuf};

use bead_house::{Finding, members_of, parameters_of, tags_of};

// the Rust side's folder, implementations/rust
fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn read(path: &Path) -> Result<String, String> {
    fs::read_to_string(path).map_err(|error| format!("{} read: {error}", path.display()))
}

// every .rs file under `folder`, in a stable order
fn sources_under(folder: &Path, found: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(folder) else {
        return;
    };
    let mut paths: Vec<PathBuf> = entries
        .filter_map(|entry| entry.ok().map(|entry| entry.path()))
        .collect();

    paths.sort();

    for path in paths {
        if path.is_dir() {
            sources_under(&path, found);
        } else if path.extension().is_some_and(|extension| extension == "rs") {
            found.push(path);
        }
    }
}

// the members' folders, as the workspace names them: each crate's, and the bench's
fn crates() -> Vec<PathBuf> {
    let mut folders: Vec<PathBuf> = fs::read_dir(root().join("crates"))
        .into_iter()
        .flatten()
        .filter_map(|entry| entry.ok().map(|entry| entry.path()))
        .chain([root().join("benches")])
        .filter(|path| path.join("Cargo.toml").is_file())
        .collect();

    folders.sort();
    folders
}

// every source the side builds: each crate's src, tests and benches, and the fuzz targets
fn sources() -> Vec<PathBuf> {
    let mut found = Vec::new();

    for folder in crates() {
        for part in ["src", "tests", "benches"] {
            sources_under(&folder.join(part), &mut found);
        }
    }

    sources_under(&root().join("fuzz/fuzz_targets"), &mut found);

    found
}

fn said(path: &Path, findings: &[Finding]) -> Vec<String> {
    findings
        .iter()
        .map(|finding| format!("{}:{}: {}", path.display(), finding.line, finding.reason))
        .collect()
}

// the lines a case file marks refused: each right after a `// refused:` comment
fn marked(source: &str) -> Vec<usize> {
    source
        .lines()
        .enumerate()
        .filter(|(_, line)| line.trim_start().starts_with("// refused:"))
        .map(|(index, _)| index.saturating_add(2))
        .collect()
}

fn lines_of(findings: &[Finding]) -> Vec<usize> {
    let mut lines: Vec<usize> = findings.iter().map(|finding| finding.line).collect();

    lines.dedup();
    lines
}

#[test]
fn every_function_takes_two_parameters_then_one_options_struct_at_most() {
    let refused: Vec<String> = sources()
        .iter()
        .flat_map(|path| {
            let file = syn::parse_file(&read(path).expect("its source read"))
                .unwrap_or_else(|error| panic!("{} parsed: {error}", path.display()));

            said(path, &parameters_of(&file))
        })
        .collect();

    assert!(
        refused.is_empty(),
        "the parameter rule refuses:\n{}",
        refused.join("\n")
    );
}

#[test]
fn a_doc_comment_carries_no_tag() {
    let refused: Vec<String> = sources()
        .iter()
        .flat_map(|path| said(path, &tags_of(&read(path).expect("its source read"))))
        .collect();

    assert!(
        refused.is_empty(),
        "the comment tags refuse:\n{}",
        refused.join("\n")
    );
}

#[test]
fn every_member_is_under_the_workspace_s_lints() {
    let refused: Vec<String> = crates()
        .iter()
        .flat_map(|folder| {
            let manifest = folder.join("Cargo.toml");

            said(
                &manifest,
                &members_of(&read(&manifest).expect("its manifest read")),
            )
        })
        .collect();

    assert!(!crates().is_empty(), "the members found");
    assert!(
        refused.is_empty(),
        "outside the workspace's lints:\n{}",
        refused.join("\n")
    );
    assert_eq!(
        members_of("[package]\nname = \"a\"\n\n[lints.clippy]\nall = \"allow\"\n").len(),
        1,
        "a member of lints of its own refused"
    );
}

#[test]
fn refuses_exactly_the_lines_its_cases_mark() {
    let cases = Path::new(env!("CARGO_MANIFEST_DIR")).join("cases");
    let parameters = read(&cases.join("parameters.rs")).expect("the parameter cases read");
    let tags = read(&cases.join("tags.rs")).expect("the tag cases read");
    let file = syn::parse_file(&parameters).expect("the parameter cases parsed");

    assert_eq!(
        lines_of(&parameters_of(&file)),
        marked(&parameters),
        "the parameter rule's cases"
    );
    assert_eq!(
        lines_of(&tags_of(&tags)),
        marked(&tags),
        "the comment tags' cases"
    );
}
