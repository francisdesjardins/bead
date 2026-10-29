//! `bead-bench`, the Rust side's in-memory bench (decision 0036): calls of the interop service's
//! echo on one in-memory connection kept, and exchanges, each a client and its connection drawn,
//! called once and closed, at each size, its latencies and its throughput, written as
//! `bead-bench/1` for `tools/bench-compare.mjs`.
//!
//! `cargo run --release --locked --manifest-path benches/Cargo.toml -- [--runs 3] [--seconds 3]
//! [--json] [--filter id-or-name]`

#![expect(
    clippy::print_stdout,
    clippy::print_stderr,
    reason = "a bench writes its report, and its progress beside it"
)]
#![expect(
    clippy::disallowed_methods,
    clippy::disallowed_types,
    reason = "a native bench: its clients run on tokio's tasks, timed by std's instant"
)]

use std::collections::BTreeMap;
use std::process::Command;
use std::sync::Arc;
use std::time::{Duration, Instant};

use bead::{
    Client, ClientOptions, MemoryClient, MemoryClientOptions, MemoryConnectOptions, MemoryServer,
    MemoryServerOptions, Procedure, RequestDependencies, RequestOptions, Server, ServerOptions,
    ServerTransport,
};
use bead_interop::{interop_procedures, offer_interop};
use serde_json::{Value, json};

// the calls a throughput keeps under way at once
const CONCURRENCY: usize = 32;

// each payload's size, as the other sides' benches measure it
const SIZES: [usize; 3] = [0, 1_024, 65_536];

// the calls the other sides count a call's memory over, which this side does not measure
const MEMORY_CALLS: u64 = 2_000;

// the calls a measure warms up on
const WARM_UP: usize = 500;

/// How a run goes: its runs, the seconds of each measure, the report as JSON, and the measure it
/// keeps to.
struct Options {
    runs: u32,
    seconds: u64,
    json: bool,
    filter: Option<String>,
}

fn options_of(arguments: &[String]) -> Result<Options, String> {
    let mut options = Options {
        runs: 3,
        seconds: 3,
        json: false,
        filter: None,
    };
    let mut given = arguments.iter();

    while let Some(flag) = given.next() {
        match flag.as_str() {
            "--json" => options.json = true,
            "--runs" | "--seconds" => {
                let value: u32 = given
                    .next()
                    .and_then(|value| value.parse().ok())
                    .filter(|value| *value > 0)
                    .ok_or_else(|| format!("{flag} takes a whole number above 0"))?;

                if flag == "--runs" {
                    options.runs = value;
                } else {
                    options.seconds = u64::from(value);
                }
            }
            "--filter" => {
                let value = given
                    .next()
                    .filter(|value| !value.starts_with("--"))
                    .ok_or("--filter takes one id or name")?;

                options.filter = Some(value.clone());
            }
            "--transcoding" => {
                return Err(
                    "the Rust side has no gateway yet: its bench measures no transcoding"
                        .to_owned(),
                );
            }
            other => return Err(format!("unknown flag {other}")),
        }
    }

    Ok(options)
}

/// One measure, by its identity, and its samples, one a run.
struct Measure {
    name: String,
    size_bytes: usize,
    unit: &'static str,
    samples: Vec<f64>,
}

#[derive(Default)]
struct Measures {
    filter: Option<String>,
    rows: BTreeMap<String, Measure>,
}

impl Measures {
    fn id_of((name, size_bytes): (&str, usize)) -> String {
        format!("local.memory.{size_bytes}.{name}")
    }

    fn is_selected(&self, (name, size_bytes): (&str, usize)) -> bool {
        self.filter
            .as_ref()
            .is_none_or(|filter| filter == name || *filter == Self::id_of((name, size_bytes)))
    }

    fn record(&mut self, (name, size_bytes): (&str, usize), (value, unit): (f64, &'static str)) {
        if !self.is_selected((name, size_bytes)) {
            return;
        }

        self.rows
            .entry(Self::id_of((name, size_bytes)))
            .or_insert_with(|| Measure {
                name: name.to_owned(),
                size_bytes,
                unit,
                samples: Vec::new(),
            })
            .samples
            .push(value);
    }
}

// the share of `sorted`, in hundredths, as the other sides' benches read a percentile
fn percentile(sorted: &[f64], hundredths: usize) -> f64 {
    let index = sorted
        .len()
        .saturating_mul(hundredths)
        .checked_div(100)
        .unwrap_or(0)
        .min(sorted.len().saturating_sub(1));

    sorted.get(index).copied().unwrap_or_default()
}

fn median(samples: &[f64]) -> f64 {
    let mut sorted = samples.to_vec();

    sorted.sort_by(f64::total_cmp);

    let middle = sorted.len().checked_div(2).unwrap_or(0);

    if sorted.len().is_multiple_of(2) {
        let low = sorted
            .get(middle.saturating_sub(1))
            .copied()
            .unwrap_or_default();
        let high = sorted.get(middle).copied().unwrap_or_default();

        low.midpoint(high)
    } else {
        sorted.get(middle).copied().unwrap_or_default()
    }
}

// a whole count as a double, past 2^32 held at it
fn double_of(count: usize) -> f64 {
    u32::try_from(count).map_or_else(|_past| f64::from(u32::MAX), f64::from)
}

/// The interop service on an in-memory server, and a client of it connected.
struct Stand {
    memory: MemoryServer,
    server: Server,
    client: Client,
    echo: Procedure,
}

async fn stand() -> Result<Stand, String> {
    let memory =
        MemoryServer::new(&MemoryServerOptions::default()).map_err(|error| error.to_string())?;
    let server = Server::new(Arc::new(memory.clone()), &ServerOptions::default())
        .map_err(|error| error.to_string())?;

    offer_interop(&server).map_err(|error| error.to_string())?;
    memory.start().await.map_err(|error| error.to_string())?;

    let (client, _) = connected(&memory).await?;
    let echo = interop_procedures(None)
        .map_err(|error| error.to_string())?
        .echo
        .procedure()
        .clone();

    Ok(Stand {
        memory,
        server,
        client,
        echo,
    })
}

// a client of `memory`, connected, and its transport
async fn connected(memory: &MemoryServer) -> Result<(Client, MemoryClient), String> {
    let transport = MemoryClient::new(&MemoryClientOptions::of(memory.clone()))
        .map_err(|error| error.to_string())?;
    let client = Client::new(Arc::new(transport.clone()), &ClientOptions::default())
        .map_err(|error| error.to_string())?;

    transport
        .connect(MemoryConnectOptions::default())
        .await
        .map_err(|error| error.to_string())?;

    Ok((client, transport))
}

async fn echo_on(client: &Client, (echo, body): (&Procedure, &str)) -> Result<(), String> {
    client
        .services()
        .get_request(
            echo,
            RequestDependencies::of(bead::JsonCodec, bead::JsonCodec),
        )
        .map_err(|error| error.to_string())?
        .call(Value::from(body), RequestOptions::default())
        .map_err(|error| error.to_string())?
        .await
        .map(drop)
        .map_err(|error| error.to_string())
}

// a call on the connection kept, or, as an exchange, a client and its connection drawn, called
// once and closed
async fn once(stand: &Stand, (body, is_exchange): (&str, bool)) -> Result<(), String> {
    if !is_exchange {
        return echo_on(&stand.client, (&stand.echo, body)).await;
    }

    let (client, transport) = connected(&stand.memory).await?;
    let called = echo_on(&client, (&stand.echo, body)).await;

    client.dispose().await;
    transport.close();

    called
}

// one measure's latencies and its throughput, into `measures`
async fn measure(
    (stand, measures): (&Arc<Stand>, &mut Measures),
    (size_bytes, is_exchange, seconds): (usize, bool, u64),
) -> Result<(), String> {
    let measure = if is_exchange { "exchange" } else { "call" };
    let names = ["p50", "p95", "p99", "throughput"].map(|suffix| format!("{measure}.{suffix}"));

    if !names
        .iter()
        .any(|name| measures.is_selected((name, size_bytes)))
    {
        return Ok(());
    }

    let body = "x".repeat(size_bytes);
    let span = Duration::from_secs(seconds);

    for _ in 0..WARM_UP {
        once(stand, (&body, is_exchange)).await?;
    }

    eprintln!("calls local/memory/{size_bytes} {measure}");

    let mut durations = Vec::new();
    let started = Instant::now();

    while started.elapsed() < span {
        let before = Instant::now();

        once(stand, (&body, is_exchange)).await?;
        durations.push(before.elapsed().as_secs_f64() * 1_000_000.0);
    }

    durations.sort_by(f64::total_cmp);

    for (name, hundredths) in [("p50", 50), ("p95", 95), ("p99", 99)] {
        measures.record(
            (&format!("{measure}.{name}"), size_bytes),
            (percentile(&durations, hundredths), "us"),
        );
    }

    let mut done = 0_usize;
    let started = Instant::now();

    while started.elapsed() < span {
        let mut running = tokio::task::JoinSet::new();

        for _ in 0..CONCURRENCY {
            let (stand, body) = (Arc::clone(stand), body.clone());

            running.spawn(async move { once(&stand, (&body, is_exchange)).await });
        }

        while let Some(finished) = running.join_next().await {
            finished.map_err(|error| error.to_string())??;
        }

        done = done.saturating_add(CONCURRENCY);
    }

    let unit = if is_exchange {
        "exchanges/s"
    } else {
        "calls/s"
    };

    measures.record(
        (&format!("{measure}.throughput"), size_bytes),
        (double_of(done) / started.elapsed().as_secs_f64(), unit),
    );

    Ok(())
}

fn text_of(command: &str, arguments: &[&str]) -> Option<String> {
    let output = Command::new(command).args(arguments).output().ok()?;

    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).trim().to_owned())
        .filter(|text| !text.is_empty())
}

fn cpu_model() -> String {
    std::fs::read_to_string("/proc/cpuinfo")
        .ok()
        .and_then(|info| {
            info.lines()
                .find(|line| line.starts_with("model name"))
                .and_then(|line| line.split_once(':'))
                .map(|(_, model)| model.trim().to_owned())
        })
        .or_else(|| std::env::var("PROCESSOR_IDENTIFIER").ok())
        .unwrap_or_else(|| "unknown".to_owned())
}

fn os_release() -> String {
    std::fs::read_to_string("/proc/sys/kernel/osrelease")
        .ok()
        .map(|release| release.trim().to_owned())
        .or_else(|| text_of("cmd", &["/c", "ver"]))
        .unwrap_or_else(|| "unknown".to_owned())
}

fn report_of((options, measures): (&Options, &Measures)) -> Result<Value, String> {
    let commit = text_of(
        "git",
        &["-C", env!("CARGO_MANIFEST_DIR"), "rev-parse", "HEAD"],
    )
    .ok_or("the bench names its commit: git rev-parse HEAD gave none")?;
    let rows: Vec<Value> = measures
        .rows
        .iter()
        .map(|(id, row)| {
            let mut sorted = row.samples.clone();

            sorted.sort_by(f64::total_cmp);

            json!({
                "id": id,
                "name": row.name,
                "scenario": "local",
                "transport": "memory",
                "sizeBytes": row.size_bytes,
                "unit": row.unit,
                "direction": if row.unit.ends_with("/s") { "higher" } else { "lower" },
                "samples": row.samples,
                "median": median(&row.samples),
                "min": sorted.first(),
                "max": sorted.last(),
            })
        })
        .collect();

    Ok(json!({
        "schema": "bead-bench/1",
        "side": "rust",
        "environment": {
            "cpu": {
                "model": cpu_model(),
                "count": std::thread::available_parallelism().map_or(1, usize::from),
            },
            "os": {
                "platform": std::env::consts::OS,
                "release": os_release(),
                "architecture": std::env::consts::ARCH,
            },
            "runtimes": { "rustc": env!("CARGO_PKG_RUST_VERSION") },
            "commit": commit,
        },
        "method": {
            "runs": options.runs,
            "filter": options.filter,
            "seconds": options.seconds,
            "concurrency": CONCURRENCY,
            "notificationIntervalMs": 1,
            "notificationWindow": CONCURRENCY,
            "memoryCalls": MEMORY_CALLS,
            "memory": {
                "method": "none",
                "scope": "none",
                "limitations": "Not measured: counting a call's allocations takes a global allocator of the bench's own, which unsafe code alone writes, and the Rust side forbids it.",
            },
            "transfer": "not measured: the Rust side's in-memory bench alone (decision 0036)",
            "interop": "none: the Rust side's in-memory bench alone (decision 0036)",
            "memoryTransport": "local only: calls on one in-memory connection kept, and exchanges, each a client and its connection drawn, called once and closed",
        },
        "measures": rows,
    }))
}

#[tokio::main]
async fn main() -> Result<(), String> {
    let arguments: Vec<String> = std::env::args().skip(1).collect();
    let options = options_of(&arguments)?;
    let stand = Arc::new(stand().await?);
    let mut measures = Measures {
        filter: options.filter.clone(),
        ..Measures::default()
    };

    for run in 1..=options.runs {
        eprintln!("run {run}/{}", options.runs);

        for size_bytes in SIZES {
            for is_exchange in [false, true] {
                measure(
                    (&stand, &mut measures),
                    (size_bytes, is_exchange, options.seconds),
                )
                .await?;
            }
        }
    }

    if measures.rows.is_empty() {
        return Err(format!(
            "filter matches no measurement: {}",
            options.filter.unwrap_or_default()
        ));
    }

    let report = report_of((&options, &measures))?;

    if options.json {
        println!(
            "{}",
            serde_json::to_string_pretty(&report).map_err(|error| error.to_string())?
        );
    } else {
        for row in report
            .get("measures")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            println!(
                "| {} | {} | {} |",
                row.get("id").and_then(Value::as_str).unwrap_or_default(),
                row.get("unit").and_then(Value::as_str).unwrap_or_default(),
                row.get("median")
                    .and_then(Value::as_f64)
                    .unwrap_or_default()
            );
        }
    }

    stand.client.dispose().await;
    stand.server.dispose().await;
    stand.memory.stop().await;

    Ok(())
}
