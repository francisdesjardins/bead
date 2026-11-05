//! A session's values and events own copies of the data its store holds.

use serde_json::{Value, json};

use super::{FIRST, Session, SessionEvent, SessionManager, at, handle, milliseconds};

fn data(username: &str) -> Value {
    json!({"roles": ["admin"], "username": username})
}

fn add_role(data: &mut Option<Value>, role: &str) {
    data.as_mut().expect("session data")["roles"]
        .as_array_mut()
        .expect("roles")
        .push(Value::String(role.to_owned()));
}

#[test]
fn hands_out_copies_changing_one_however_deep_changes_nothing_stored() {
    let mut sessions = SessionManager::new();
    let mut session = sessions.get_or_else_set(FIRST);
    session.data = Some(data("guest"));
    sessions
        .manager
        .update_data((&handle(FIRST), session.data.clone()), &mut sessions.told);
    add_role(&mut session.data, "owner");
    let mut got = sessions
        .manager
        .get(&handle(FIRST))
        .expect("the stored session");
    add_role(&mut got.data, "intruder");
    let mut all = sessions.manager.all();
    add_role(&mut all[0].data, "intruder");
    assert_eq!(
        sessions.manager.data_of(&handle(FIRST)),
        Some(data("guest"))
    );
    let first = sessions.manager.get(&handle(FIRST)).expect("one copy");
    let second = sessions.manager.get(&handle(FIRST)).expect("another copy");
    assert!(!core::ptr::eq(
        first.data.as_ref().expect("first data")["roles"]
            .as_array()
            .expect("first roles")
            .as_ptr(),
        second.data.as_ref().expect("second data")["roles"]
            .as_array()
            .expect("second roles")
            .as_ptr(),
    ));
}

fn tamper(events: &mut [SessionEvent]) {
    for event in events {
        if let SessionEvent::Created(session)
        | SessionEvent::Updated(session)
        | SessionEvent::DataChanged { session, .. }
        | SessionEvent::LastActivityChanged { session, .. } = event
        {
            add_role(&mut session.data, "intruder");
        }
        if let SessionEvent::DataChanged { new_value, .. } = event {
            add_role(new_value, "intruder");
        }
    }
}

#[test]
fn nothing_set_or_emitted_is_shared_with_the_store_not_the_session_set_not_a_listeners() {
    let mut sessions = SessionManager::new();
    let mut draft = SessionManager::create(FIRST);
    draft.data = Some(data("guest"));
    let stored = sessions.stored(draft.clone());
    assert!(matches!(
        sessions.told.as_slice(),
        [SessionEvent::Created(_)]
    ));
    tamper(&mut sessions.taken());
    add_role(&mut draft.data, "owner");
    assert_eq!(
        sessions.manager.data_of(&handle(FIRST)),
        Some(data("guest"))
    );
    sessions.stored(Session {
        connection_inactivity_timeout: Some(milliseconds(1)),
        ..stored
    });
    assert!(matches!(
        sessions.told.as_slice(),
        [SessionEvent::Updated(_)]
    ));
    tamper(&mut sessions.taken());
    assert_eq!(
        sessions.manager.data_of(&handle(FIRST)),
        Some(data("guest"))
    );
    sessions
        .manager
        .update_data((&handle(FIRST), Some(data("other"))), &mut sessions.told);
    assert!(matches!(
        sessions.told.as_slice(),
        [SessionEvent::DataChanged { .. }]
    ));
    tamper(&mut sessions.taken());
    sessions.touch((FIRST, at(5)));
    assert!(matches!(
        sessions.told.as_slice(),
        [SessionEvent::LastActivityChanged { .. }]
    ));
    tamper(&mut sessions.taken());
    let got = sessions
        .manager
        .get(&handle(FIRST))
        .expect("the stored session");
    assert_eq!(got.data, Some(data("other")));
    assert_eq!(got.last_activity, at(5));
}

#[test]
fn update_data_stores_a_copy_and_emits_data_changed_with_the_new_and_old_values() {
    let mut sessions = SessionManager::new();
    sessions.get_or_else_set(FIRST);
    sessions.taken();
    let mut supplied = Some(data("guest"));
    let stored = sessions
        .manager
        .update_data((&handle(FIRST), supplied.clone()), &mut sessions.told)
        .expect("the data changed");
    supplied.as_mut().expect("data")["username"] = Value::String("changed after".to_owned());
    add_role(&mut supplied, "owner");
    assert_eq!(
        sessions.manager.data_of(&handle(FIRST)),
        Some(data("guest"))
    );
    assert_eq!(stored.data, Some(data("guest")));
    assert_eq!(
        sessions.taken(),
        [SessionEvent::DataChanged {
            session: stored,
            new_value: Some(data("guest")),
            old_value: None,
        }]
    );
}
