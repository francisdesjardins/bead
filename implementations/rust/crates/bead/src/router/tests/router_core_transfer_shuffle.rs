//! Requests, results and commands over a wire that shuffles and duplicates only chunks and credits.

use std::sync::{Arc, Mutex};

use bytes::Bytes;

use super::locked;
use super::router_core_sessions::handler;
use super::router_core_transfer_refusals::{pattern, reports};
use crate::constants::RouterSide;
use crate::envelope::Envelope;
use crate::errors::ResolverError;
use crate::identity::Procedure;
use crate::router::core as router_core;
use crate::router::types::{RouterAnswer, RouterLimitsOptions};
use crate::testing::core_port::{Peer, completed, request_of};
use crate::testing::{pair::echo, scripted};

type Packet = (bool, Envelope);
type Heard = Arc<Mutex<Vec<(bool, Bytes)>>>;

#[derive(Debug, Default)]
struct Wire {
    queue: Vec<Packet>,
    sent: Vec<Packet>,
    delivered: Vec<Packet>,
    seed: Option<u32>,
    dotnet: bool,
}

fn loose(envelope: &Envelope) -> bool {
    matches!(envelope, Envelope::Chunk { .. } | Envelope::Credit { .. })
}

impl Wire {
    // TypeScript's fixture draws mulberry32's unsigned word, before dividing it by 2^32.
    fn draw(&mut self) -> u32 {
        let state = self.seed.as_mut().expect("a seeded wire");
        *state = state.wrapping_add(0x6D2B_79F5);
        let mut mixed = (*state ^ (*state >> 15)).wrapping_mul(*state | 1);
        mixed ^= mixed.wrapping_add((mixed ^ (mixed >> 7)).wrapping_mul(mixed | 0x3D));
        mixed ^ (mixed >> 14)
    }

    fn send(&mut self, packet: Packet) {
        self.sent.push(packet.clone());
        self.queue.push(packet.clone());
        if loose(&packet.1) {
            if self.dotnet {
                self.queue.insert(0, packet);
            } else if self.seed.is_some() && self.draw() < 0x8000_0000 {
                self.queue.push(packet);
            }
        }
    }

    fn next(&mut self) -> Option<Packet> {
        if self.queue.is_empty() {
            return None;
        }
        let index = if self.dotnet {
            self.queue.len().saturating_sub(1)
        } else if self.seed.is_some() {
            let first = self.queue.iter().position(|(_, envelope)| !loose(envelope));
            let candidates = self
                .queue
                .iter()
                .enumerate()
                .filter_map(|(index, (_, envelope))| {
                    (loose(envelope) || Some(index) == first).then_some(index)
                })
                .collect::<Vec<_>>();
            let chosen = u64::from(self.draw())
                .saturating_mul(u64::try_from(candidates.len()).expect("a queue length"))
                >> 32;
            candidates[usize::try_from(chosen).expect("a queue index")]
        } else {
            0
        };
        let packet = self.queue.remove(index);
        self.delivered.push(packet.clone());
        Some(packet)
    }
}

fn ping() -> Procedure {
    Procedure {
        procedure_id: 2,
        procedure_name: "ping".to_owned(),
        ..echo()
    }
}

async fn connect(wire: Arc<Mutex<Wire>>, (peer, to_server): (&Peer, bool)) {
    peer.owner
        .run(move |state| {
            state.on_transmit = Some(Box::new(move |_, envelope| {
                locked(&wire).send((to_server, envelope.clone()));
            }));
        })
        .await
        .expect("the peer connected to the wire");
}

async fn reply(
    peer: &Peer,
    (procedure, payload, to_server, heard): (Procedure, Bytes, bool, Heard),
) {
    let mut handler = handler((&Arc::default(), &Arc::default()));
    handler.resolve = Arc::new(move |props| {
        locked(&heard).push((to_server, props.payload));
        let responding = props
            .answerer
            .respond(RouterAnswer::Result(payload.clone()));
        Box::pin(async move { responding.await.map_err(ResolverError::other) })
    });
    peer.owner
        .run(move |state| {
            router_core::register_resolver(&state.core.resolvers, (&procedure, handler, None))
                .expect("the replying resolver registered");
        })
        .await
        .expect("the replying peer ready");
}

async fn flush(wire: &Arc<Mutex<Wire>>, (client, server): (&Peer, &Peer)) {
    client.settle().await;
    server.settle().await;
    loop {
        let next = { locked(wire).next() };
        let Some((to_server, envelope)) = next else {
            return;
        };
        assert!(locked(wire).delivered.len() < 10_000, "the wire settles");
        let peer = if to_server { server } else { client };
        peer.receive((envelope, Arc::from(if to_server { "a" } else { "server" })));
        peer.settle().await;
    }
}

fn ordered(packets: &[Packet]) -> Vec<Packet> {
    packets
        .iter()
        .filter(|(_, envelope)| !loose(envelope))
        .cloned()
        .collect()
}

fn shuffled(packets: &[Packet]) -> bool {
    packets.iter().enumerate().any(|(index, (to_server, envelope))| {
        let Envelope::Chunk { header, .. } = envelope else { return false; };
        packets[..index].iter().any(|(earlier_to, earlier)| {
            matches!(earlier, Envelope::Chunk { header: before, .. } if earlier_to == to_server && before.call_id == header.call_id && before.offset > header.offset)
        })
    })
}

#[tokio::test]
async fn carry_a_request_its_result_and_a_command_as_transfers_their_chunks_and_credits_shuffled_and_doubled()
 {
    for (dotnet, seed) in [
        (false, None),
        (false, Some(1)),
        (false, Some(2)),
        (false, Some(3)),
        (false, Some(4)),
        (false, Some(5)),
        (true, None),
    ] {
        let chunk_bytes = if dotnet { 64 } else { 1_024 };
        let options = RouterLimitsOptions {
            chunk_bytes: Some(chunk_bytes),
            maximum_envelope_bytes: (!dotnet).then_some(1_024),
            window_bytes: Some(if dotnet { 128 } else { 8_192 }),
            ..RouterLimitsOptions::default()
        };
        let client = Peer::new(RouterSide::Client, &options);
        let server = Peer::new(RouterSide::Server, &options);
        let wire = Arc::new(Mutex::new(Wire {
            seed,
            dotnet,
            ..Wire::default()
        }));
        connect(Arc::clone(&wire), (&client, true)).await;
        connect(Arc::clone(&wire), (&server, false)).await;
        let base: usize = if dotnet { 1_000 } else { 102_400 };
        let request = pattern((base.saturating_add(1), dotnet));
        let result = pattern((base.saturating_add(2), dotnet));
        let command = pattern((base.saturating_add(3), dotnet));
        let answer = pattern((if dotnet { 36 } else { 64 }, dotnet));
        let heard = Heard::default();
        reply(&server, (echo(), result.clone(), true, Arc::clone(&heard))).await;
        reply(&client, (ping(), answer.clone(), false, Arc::clone(&heard))).await;
        let mut asking_options = request_of("server");
        if dotnet {
            asking_options.options.timeout = core::time::Duration::from_secs(5);
        }
        let asking = client.request((request.clone(), asking_options));
        flush(&wire, (&client, &server)).await;
        let mut command_options = request_of("a");
        command_options.procedure = ping().address();
        if dotnet {
            command_options.options.timeout = core::time::Duration::from_secs(5);
        }
        let commanding = server.request((command.clone(), command_options));
        flush(&wire, (&client, &server)).await;
        assert_eq!(
            completed(asking)
                .await
                .expect("the request answered")
                .payload,
            result
        );
        assert_eq!(
            completed(commanding)
                .await
                .expect("the command answered")
                .payload,
            answer
        );
        assert_eq!(*locked(&heard), [(true, request), (false, command)]);
        assert_eq!(reports(&client).await, []);
        assert_eq!(reports(&server).await, []);
        let wire = locked(&wire);
        assert!(
            wire.sent
                .iter()
                .all(|(_, envelope)| scripted::bytes_of(envelope).len()
                    <= usize::try_from(chunk_bytes).expect("an envelope bound"))
        );
        for to_server in [false, true] {
            assert!(
                wire.sent
                    .iter()
                    .filter(|(to, envelope)| *to == to_server
                        && matches!(envelope, Envelope::Credit { .. }))
                    .count()
                    > 1
            );
        }
        assert_eq!(ordered(&wire.delivered), ordered(&wire.sent));
        let altered = dotnet || seed.is_some();
        assert_eq!(wire.delivered.len() > wire.sent.len(), altered);
        assert_eq!(shuffled(&wire.delivered), altered);
    }
}
