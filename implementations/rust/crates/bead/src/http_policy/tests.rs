//! An HTTP policy: one object of an HTTP server's hosts, origins, proxies and bounds, checked once
//! (decision 0037), the twin of `http-policy.test.ts` and `HttpPolicyTests`.

use core::time::Duration;

use super::{HttpPolicy, HttpPolicyOptions};
use crate::duration::NEVER;

// a policy's members given alone, each refused: a member out of its form or its bounds
fn refused_options() -> Vec<HttpPolicyOptions> {
    let mut refused = Vec::new();
    let mut hosts = HttpPolicyOptions::default();
    let mut origins = HttpPolicyOptions::default();
    let mut proxies = HttpPolicyOptions::default();
    let mut unnamed = HttpPolicyOptions::default();
    let mut body = HttpPolicyOptions::default();
    let mut headers = HttpPolicyOptions::default();

    hosts.hosts = Some(vec!["https://api.example".to_owned()]);
    origins.origins = Some(vec!["app.example".to_owned()]);
    proxies.trusted_proxies = Some(vec!["not an address".to_owned()]);
    unnamed.unnamed_proxies = Some(9);
    body.maximum_body_bytes = Some(0);
    headers.headers_timeout = Some(NEVER);
    refused.extend([hosts, origins, proxies, unnamed, body, headers]);

    refused
}

// a rate of -1, which the other sides refuse, is none here: a rate is a whole number by its type
#[test]
fn builds_a_policy_of_its_members_checked_once_and_frozen_and_refuses_one_that_does_not_hold() {
    let mut hosts = vec!["api.example".to_owned()];
    let mut options = HttpPolicyOptions {
        body_grace_period: Some(Duration::from_secs(1)),
        hosts: Some(hosts.clone()),
        maximum_connections_per_address: Some(8),
        minimum_send_bytes_per_second: Some(0),
        origins: Some(vec!["https://app.example".to_owned()]),
        trusted_proxies: Some(vec!["10.0.0.1".to_owned()]),
        unnamed_proxies: Some(1),
        ..HttpPolicyOptions::default()
    };

    let policy = HttpPolicy::of(&options).expect("a policy");

    // * its lists copied as it is built: what changes the list it was given changes nothing of it
    hosts.push("evil.example".to_owned());
    options
        .hosts
        .get_or_insert_default()
        .push("evil.example".to_owned());
    assert_eq!(
        policy.hosts(),
        Some(&["api.example".to_owned()][..]),
        "its hosts, as given"
    );
    assert_eq!(policy.maximum_body_bytes(), None, "none given");
    assert_eq!(
        policy.body_grace_period(),
        Some(Duration::from_secs(1)),
        "its grace"
    );

    for refused in refused_options() {
        HttpPolicy::of(&refused).expect_err(&format!("{refused:?}"));
    }
}
