//! A map that keeps the order its keys first came in: a key held keeps its place when set again, a
//! key removed comes last when set again, and the order holds through the holes and their compaction.

use super::Ordered;

fn keys_of(map: &Ordered<u32, &'static str>) -> Vec<u32> {
    map.keys().copied().collect()
}

fn filled(keys: &[u32]) -> Ordered<u32, &'static str> {
    let mut map = Ordered::new();

    for key in keys {
        map.insert(*key, "first");
    }

    map
}

#[test]
fn keeps_the_order_its_keys_first_came_in() {
    let mut map = filled(&[3, 1, 2]);

    assert_eq!(keys_of(&map), [3, 1, 2], "in the order they came");
    assert_eq!(
        map.insert(1, "again"),
        Some("first"),
        "the value held, given back"
    );
    assert_eq!(keys_of(&map), [3, 1, 2], "a key set again keeps its place");
    assert_eq!(map.get(&1), Some(&"again"), "its value replaced");
    assert_eq!(map.len(), 3, "three held");
    assert!(map.contains_key(&2), "2 held");
    assert!(!map.contains_key(&4), "4 never held");
    assert_eq!(map.get(&4), None, "4 has no value");
}

#[test]
fn sets_a_key_removed_last_when_it_comes_again() {
    let mut map = filled(&[1, 2, 3]);

    assert_eq!(map.remove(&2), Some("first"), "2 removed");
    assert_eq!(map.remove(&2), None, "2 no longer held");
    assert_eq!(keys_of(&map), [1, 3], "the others keep their order");
    assert_eq!(map.insert(2, "again"), None, "2 new again");
    assert_eq!(keys_of(&map), [1, 3, 2], "2 comes last");
    assert_eq!(map.get(&2), Some(&"again"), "its new value");
}

#[test]
fn keeps_its_order_and_finds_each_key_once_its_holes_are_compacted() {
    let mut map = filled(&[1, 2, 3, 4]);

    // * three holes against one held: the holes go
    for key in [1, 2, 3] {
        assert_eq!(map.remove(&key), Some("first"), "{key} removed");
    }

    assert_eq!(keys_of(&map), [4], "4 alone");
    assert_eq!(map.entries.len(), 1, "the holes gone");

    for key in [5, 6, 1] {
        map.insert(key, "first");
    }

    assert_eq!(
        keys_of(&map),
        [4, 5, 6, 1],
        "the order kept through the compaction"
    );
    assert_eq!(map.get(&4), Some(&"first"), "4 found at its new place");

    if let Some(value) = map.get_mut(&6) {
        *value = "changed";
    }

    assert_eq!(map.get(&6), Some(&"changed"), "6 changed in place");
    assert_eq!(map.remove(&5), Some("first"), "5 removed");
    assert_eq!(keys_of(&map), [4, 6, 1], "the others keep their order");
    assert_eq!(
        map.remove(&4),
        Some("first"),
        "4 removed after the compaction"
    );
    assert_eq!(map.insert(4, "again"), None, "4 new again");
    assert_eq!(keys_of(&map), [6, 1, 4], "4 last");
    assert_eq!(map.len(), 3, "three held");
}

#[test]
fn holds_its_order_through_a_long_turnover() {
    let mut map = filled(&[0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    let mut expected: Vec<u32> = (0..10).collect();

    // each key in turn removed and set again, as a connection's idle timer is armed anew
    for turn in 0..1_000_u32 {
        let key = turn % 10;

        assert_eq!(map.remove(&key), Some("first"), "{key} removed");
        map.insert(key, "first");
        expected.retain(|held| *held != key);
        expected.push(key);

        assert_eq!(keys_of(&map), expected, "the order after turn {turn}");
    }

    assert!(
        map.entries.len() <= 21,
        "the holes never outnumber what is held for long"
    );
}

#[test]
fn makes_a_value_only_for_a_key_it_does_not_hold() {
    let mut map = filled(&[1]);

    if let Some(value) = map.entry_or_insert_with(1, || "made") {
        *value = "found";
    }

    assert_eq!(map.get(&1), Some(&"found"), "the value held, found");
    assert_eq!(
        map.entry_or_insert_with(2, || "made").copied(),
        Some("made"),
        "a value made for 2"
    );
    assert_eq!(keys_of(&map), [1, 2], "2 last");
}

#[test]
fn retains_in_order_and_forgets_what_it_drops() {
    let mut map = filled(&[1, 2, 3, 4, 5, 6]);
    let mut seen = Vec::new();

    map.retain(|key, value| {
        seen.push(*key);

        if *key == 6 {
            *value = "kept";
        }

        key % 3 == 0
    });

    assert_eq!(seen, [1, 2, 3, 4, 5, 6], "each judged in order");
    assert_eq!(keys_of(&map), [3, 6], "the kept keep their order");
    assert_eq!(map.get(&6), Some(&"kept"), "a value changed while judged");
    assert!(!map.contains_key(&1), "1 forgotten");
    assert_eq!(map.insert(1, "again"), None, "1 new again");
    assert_eq!(keys_of(&map), [3, 6, 1], "1 last");
    assert_eq!(
        map.values().copied().collect::<Vec<_>>(),
        ["first", "kept", "again"],
        "the values in the same order"
    );
}

#[test]
fn drains_and_clears_in_order_and_holds_nothing_after() {
    let mut map = filled(&[2, 1, 3]);

    map.remove(&1);

    let drained: Vec<u32> = map.drain().map(|(key, _)| key).collect();

    assert_eq!(drained, [2, 3], "drained in order");
    assert!(map.is_empty(), "nothing held after a drain");
    assert!(!map.contains_key(&2), "2 forgotten by the drain");

    map.insert(5, "first");
    map.insert(4, "first");
    map.clear();

    assert!(map.is_empty(), "nothing held after a clear");
    assert_eq!(map.get(&5), None, "5 forgotten by the clear");
    assert_eq!(map.iter().count(), 0, "nothing to walk");
}
