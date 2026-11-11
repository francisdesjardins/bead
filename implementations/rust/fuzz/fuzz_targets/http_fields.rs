//! `http-fields`: the HTTP transport's field parsers, raw bytes read as a request's field. The
//! first byte picks the field, modulo the five below; the others are its value, one character an
//! octet, as the other sides read a field's octets in Latin-1, each line feed parting two of its
//! lines. No parser here refuses by panicking: each returns, and a panic is a finding. The other
//! sides' `http-fields` targets are its twins, slot for slot, with the same server around them.

#![no_main]

use std::sync::LazyLock;

use bead::internal::hosts::{
    HostRequest, TakenOrigins, authority_of, credential_of, host_part_of, is_authority,
    is_listed_origin, is_taken_host, is_taken_origin, is_visible_field, is_well_formed_host,
    origin_of, own_authority_of, request_target_of,
};
use bead::internal::items::parse_item;
use bead::internal::proxies::{
    ClientAddressOptions, TrustedProxies, address_of_entry, client_address_of, trusted_proxies_of,
};
use libfuzzer_sys::fuzz_target;

// the server the fields come to: its socket's peer, a proxy it names, and what it takes
const REMOTE_ADDRESS: &str = "10.0.0.1";
const OWN_AUTHORITY: &str = "localhost:8080";

static TRUSTED_PROXIES: LazyLock<Option<TrustedProxies>> = LazyLock::new(|| {
    trusted_proxies_of(
        &["10.0.0.0/8".to_owned(), "2001:db8::/32".to_owned()],
        Some(2),
    )
    .ok()
});
static HOSTS: LazyLock<Vec<String>> = LazyLock::new(|| vec!["example.test".to_owned()]);
static ORIGINS: LazyLock<Vec<String>> =
    LazyLock::new(|| vec!["https://app.example.test".to_owned()]);

// the fields, by the first byte's slot: `bead-after`, `bead-wait` and `bead-listen`, an Item of
// RFC 9651; `Authorization`; `X-Forwarded-For`; the request's target, its first line, then its
// `Host`'s lines; `Origin`
const ITEM: u8 = 0;
const AUTHORIZATION: u8 = 1;
const FORWARDED_FOR: u8 = 2;
const HOST: u8 = 3;
const SLOT_COUNT: u8 = 5;

fn read_forwarded_for(value: &str) {
    for entry in value.split(',') {
        core::hint::black_box(address_of_entry(entry));
    }

    let mut options = ClientAddressOptions::default();

    options.forwarded = Some(value);
    options.trusted_proxies = TRUSTED_PROXIES.as_ref();
    core::hint::black_box(client_address_of(REMOTE_ADDRESS, &options));
}

fn read_host(lines: &[&str]) {
    let Some((line, host_lines)) = lines.split_first() else {
        return;
    };
    let target = request_target_of(Some(line));

    core::hint::black_box(is_well_formed_host(host_lines, true));

    let authority =
        authority_of(host_lines, &HostRequest::new(true, target)).and_then(|read| read.authority);

    for named in [
        authority,
        target.and_then(|target| target.authority),
        host_lines.first().copied(),
    ]
    .into_iter()
    .flatten()
    {
        core::hint::black_box(is_authority(named));
        core::hint::black_box(host_part_of(named));
        core::hint::black_box(is_taken_host(Some(named), &HOSTS));
        core::hint::black_box(own_authority_of(Some(named), &HOSTS));
    }
}

fn read_origin(lines: &[&str]) {
    let origin = origin_of(lines);

    core::hint::black_box(is_taken_origin(
        origin.as_deref(),
        &TakenOrigins::new(Some(OWN_AUTHORITY), &ORIGINS),
    ));
    core::hint::black_box(is_listed_origin(origin.as_deref(), &ORIGINS));
}

fuzz_target!(|data: &[u8]| {
    let (slot, rest) = data.split_first().map_or((0, &[][..]), |(first, rest)| (*first, rest));
    let value: String = rest.iter().copied().map(char::from).collect();
    let lines: Vec<&str> = value.split('\n').collect();

    for line in &lines {
        core::hint::black_box(is_visible_field(line));
    }

    match slot % SLOT_COUNT {
        ITEM => {
            core::hint::black_box(parse_item(&value));
        }
        AUTHORIZATION => {
            core::hint::black_box(credential_of(&lines));
        }
        FORWARDED_FOR => read_forwarded_for(&value),
        HOST => read_host(&lines),
        _ => read_origin(&lines),
    }
});
