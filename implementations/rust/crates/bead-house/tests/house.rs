//! The house's checks over the Rust side, and over the cases of each verdict: every function's
//! parameters, every options struct's shape, each library crate's surface against its list and
//! without a tuple, every doc comment's opening, and every member's lints.

use std::fs;
use std::path::{Path, PathBuf};

use bead_house::{
    Finding, crate_tuples_of, members_of, options_of, parameters_of, surface_of, tags_of, tuples_of,
};

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
fn every_options_struct_is_non_exhaustive_never_copy_its_fields_options_but_what_its_constructor_takes()
 {
    let refused: Vec<String> = sources()
        .iter()
        .flat_map(|path| {
            let file = syn::parse_file(&read(path).expect("its source read"))
                .unwrap_or_else(|error| panic!("{} parsed: {error}", path.display()));

            said(path, &options_of(&file))
        })
        .collect();

    assert!(
        refused.is_empty(),
        "the options struct's shape refuses:\n{}",
        refused.join("\n")
    );
}

// the library crates whose surface is pinned, each by its package and its folder
const LIBRARIES: [(&str, &str); 3] = [
    ("francisdesjardins-bead", "crates/bead"),
    ("francisdesjardins-bead-protobuf", "crates/bead-protobuf"),
    (
        "francisdesjardins-bead-protobuf-build",
        "crates/bead-protobuf-build",
    ),
];

// the lines one list holds and the other does not, each marked by the list that holds it
fn differences(listed: &str, read: &str) -> Vec<String> {
    let gone = listed
        .lines()
        .filter(|line| !read.lines().any(|other| other == *line))
        .map(|line| format!("- {line}"));
    let added = read
        .lines()
        .filter(|line| !listed.lines().any(|other| other == *line))
        .map(|line| format!("+ {line}"));

    gone.chain(added).collect()
}

#[test]
fn each_crate_exposes_its_list() {
    let surfaces = Path::new(env!("CARGO_MANIFEST_DIR")).join("surfaces");
    // * BEAD_HOUSE_WRITE=1 writes each list anew, as insta's INSTA_UPDATE does; the diff is the
    // change's to review
    let is_writing = std::env::var_os("BEAD_HOUSE_WRITE").is_some_and(|value| value == "1");

    for (package, folder) in LIBRARIES {
        let read = surface_of(&root().join(folder)).expect("its surface read");
        let path = surfaces.join(format!("{package}.txt"));

        assert!(read.lines().count() > 1, "{package}: no item read");

        if is_writing {
            fs::write(&path, &read).expect("its list written");

            continue;
        }

        let listed = read_list(&path).expect("its list read");
        let differences = differences(&listed, &read);

        assert!(
            listed == read,
            "{package}'s surface leaves its list ({}), BEAD_HOUSE_WRITE=1 to write it anew:\n{}",
            path.display(),
            differences.join("\n")
        );
    }
}

#[test]
fn takes_and_gives_no_tuple_on_the_public_surface() {
    let refused: Vec<String> = LIBRARIES
        .iter()
        .flat_map(|(_, folder)| crate_tuples_of(&root().join(folder)).expect("its sources read"))
        .collect();

    assert!(
        refused.is_empty(),
        "the surface takes or gives a tuple:
{}",
        refused.join(
            "
"
        )
    );
}

// a list, its line endings as git may have checked them out
fn read_list(path: &Path) -> Result<String, String> {
    read(path).map(|list| list.replace("\r\n", "\n"))
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
    let options = read(&cases.join("options.rs")).expect("the options cases read");
    let tags = read(&cases.join("tags.rs")).expect("the tag cases read");
    let tuples = read(&cases.join("tuples.rs")).expect("the tuple cases read");
    let file = syn::parse_file(&parameters).expect("the parameter cases parsed");

    assert_eq!(
        lines_of(&parameters_of(&file)),
        marked(&parameters),
        "the parameter rule's cases"
    );
    assert_eq!(
        lines_of(&options_of(
            &syn::parse_file(&options).expect("the options cases parsed")
        )),
        marked(&options),
        "the options struct's cases"
    );
    assert_eq!(
        lines_of(&tags_of(&tags)),
        marked(&tags),
        "the comment tags' cases"
    );
    assert_eq!(
        lines_of(&tuples_of(
            &syn::parse_file(&tuples).expect("the tuple cases parsed")
        )),
        marked(&tuples),
        "the tuple cases"
    );
}
