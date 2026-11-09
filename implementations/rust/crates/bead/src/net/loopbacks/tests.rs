use std::io;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::sync::atomic::{AtomicU16, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use super::*;

type Calls = Arc<Mutex<Vec<(Vec<IpAddr>, u16)>>>;

const BOTH: [IpAddr; 2] = [
    IpAddr::V4(Ipv4Addr::LOCALHOST),
    IpAddr::V6(Ipv6Addr::LOCALHOST),
];

fn binding_of<D, R>(draw: D, refusal: R) -> LoopbackBinding
where
    D: Fn() -> io::Result<u16> + Send + Sync + 'static,
    R: Fn(u16) -> Option<io::Error> + Send + Sync + 'static,
{
    LoopbackBinding {
        port: 0,
        find_open_port: true,
        draw_port: Box::new(draw),
        ipv6_refusal: Some(Box::new(refusal)),
    }
}

fn recording(calls: &Calls) -> impl FnMut(&[IpAddr], u16) -> io::Result<&'static str> + use<> {
    let calls = Arc::clone(calls);

    move |addresses: &[IpAddr], port: u16| {
        calls.lock().unwrap().push((addresses.to_vec(), port));

        Ok("bound")
    }
}

#[test]
fn draws_another_port_for_an_occupied_loopback_in_the_platform_bind_failure() {
    let draws = Arc::new(AtomicU16::new(0));
    let counter = Arc::clone(&draws);
    let calls: Calls = Arc::default();
    let binding = binding_of(
        move || Ok(42_000 + counter.fetch_add(1, Ordering::SeqCst)),
        |port| (port == 42_000).then(|| io::Error::from(io::ErrorKind::AddrInUse)),
    );

    let bound = bind_loopbacks(recording(&calls), &binding).unwrap();

    assert_eq!(draws.load(Ordering::SeqCst), 2, "a port drawn again");
    assert_eq!(bound.started, "bound", "what it started");
    assert_eq!(bound.address, "localhost", "both loopbacks");
    assert_eq!(
        *calls.lock().unwrap(),
        vec![(BOTH.to_vec(), 42_001)],
        "one bind, on the second port"
    );
}

#[test]
fn falls_back_to_ipv4_only_for_an_absent_loopback_in_the_platform_bind_failure() {
    // * what the platform says of an address it lacks, and of a family it lacks
    let refusals: [fn() -> io::Error; 2] = [
        || io::Error::from(io::ErrorKind::AddrNotAvailable),
        || io::Error::from_raw_os_error(FAMILY_NOT_SUPPORTED),
    ];

    for refusal in refusals {
        let draws = Arc::new(AtomicUsize::new(0));
        let counter = Arc::clone(&draws);
        let calls: Calls = Arc::default();
        let binding = binding_of(
            move || {
                counter.fetch_add(1, Ordering::SeqCst);

                Ok(42_000)
            },
            move |_port| Some(refusal()),
        );

        let bound = bind_loopbacks(recording(&calls), &binding).unwrap();

        assert_eq!(draws.load(Ordering::SeqCst), 1, "one port drawn");
        assert_eq!(bound.started, "bound", "what it started");
        assert_eq!(bound.address, "127.0.0.1", "the IPv4 loopback alone");
        assert_eq!(
            *calls.lock().unwrap(),
            vec![(vec![IpAddr::V4(Ipv4Addr::LOCALHOST)], 42_000)],
            "one bind, on IPv4 alone"
        );
    }
}

#[test]
fn propagates_a_bind_failure_whose_platform_errors_name_no_absent_loopback_or_occupied_port() {
    let draws = Arc::new(AtomicUsize::new(0));
    let counter = Arc::clone(&draws);
    let calls: Calls = Arc::default();
    let binding = binding_of(
        move || {
            counter.fetch_add(1, Ordering::SeqCst);

            Ok(42_000)
        },
        |_port| Some(io::Error::from(io::ErrorKind::PermissionDenied)),
    );

    let refused = bind_loopbacks(recording(&calls), &binding).unwrap_err();

    assert_eq!(refused.kind(), io::ErrorKind::PermissionDenied, "its own");
    assert_eq!(draws.load(Ordering::SeqCst), 1, "one port drawn");
    assert!(calls.lock().unwrap().is_empty(), "nothing bound");
}
