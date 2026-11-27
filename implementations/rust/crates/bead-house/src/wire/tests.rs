use super::{wire_literals_of, wire_modules_of};

// a table of the form `tools/wire-names.tsv` states: its head, a holder's rows, a reason, and a
// readers' row
const TABLE: &str = "# format\tconcept\tstandard\tvalue\ttypescript\tcsharp\trust\n\
    websocket\tFIN_BIT\tRFC 6455 §5.2\t0x80\ta.ts\tA.cs\tcrates/bead/src/websocket_frame.rs\n\
    websocket\tNORMAL_CLOSURE\tRFC 6455 §7.4.1\t1000\ta.ts\tA.cs#Codes.NormalClosure\tcrates/bead/src/websocket_frame.rs#codes::NORMAL_CLOSURE, crates/bead-protobuf/src/records.rs\n\
    amqp\tLIST8\tAMQP 1.0\t0xC0\ta.ts\tA.cs\t-: no binding, crates/bead/src/none.rs\n\
    websocket\t@reads\t\t-\tb.ts\tB.cs\tcrates/bead/src/websocket/meter.rs, crates/bead/src/broker/parcel.rs\n";

#[test]
fn reads_the_rust_cell_of_every_row_holders_and_readers_alike_each_path_once() {
    assert_eq!(
        wire_modules_of(TABLE),
        Ok(vec![
            "crates/bead/src/websocket_frame.rs".to_owned(),
            "crates/bead-protobuf/src/records.rs".to_owned(),
            "crates/bead/src/websocket/meter.rs".to_owned(),
            "crates/bead/src/broker/parcel.rs".to_owned(),
        ]),
        "each path before its name, a reason never read for one"
    );
}

#[test]
fn refuses_a_row_of_another_number_of_cells_than_seven() {
    assert_eq!(
        wire_modules_of("websocket\tFIN_BIT\tRFC 6455 §5.2\t0x80\ta.ts\tA.cs\n"),
        Err("line 1: 6 cells, the table's are 7".to_owned()),
        "a row short of its Rust cell refused"
    );
}

#[test]
fn refuses_each_literal_by_its_own_line_in_a_macro_s_tokens() {
    let file = syn::parse_file(
        "fn filled() -> Vec<u8> {\n    vec![\n        0x80;\n        4\n    ]\n}\n",
    )
    .expect("the source parsed");
    let lines: Vec<usize> = wire_literals_of(&file)
        .iter()
        .map(|finding| finding.line)
        .collect();

    assert_eq!(lines, [3], "the literal's own line");
}
