// ── Sliced sends ──────────────────────────────────────────────────────────────

// constants

/**
 * The most a page's link puts in one WebSocket message: 16 KiB, a quarter of the 65,536 bytes at
 * most that Chromium sends as one frame (`kSmallMessageThreshold`, services/network/websocket.cc),
 * so that a lower threshold, in Chromium or in an engine not measured, still sends it whole.
 */
export const LARGEST_PAGE_MESSAGE = 16_384;

// definition

/**
 * `socket`, each message it sends cut in order into messages of {@link LARGEST_PAGE_MESSAGE} bytes
 * at most, none empty, so that Chromium sends each as one binary frame (spec 15.25). MQTT over a
 * WebSocket is a stream of bytes, its packets aligned on no message (MQTT 5.0 §6.0,
 * [MQTT-6.0.0-2]), so the broker reads the same packets; and MQTT.js joins the packets that waited
 * into one message, past 64 KiB in a burst.
 */
export const withSlicedSends = <Socket extends Pick<WebSocket, 'send'>>(socket: Socket): Socket => {
  const send = socket.send.bind(socket);

  // ! no message Chromium fragments: amid one, Mosquitto 2.1.2 frames its own as a continuation
  socket.send = (data) => {
    if (typeof data === 'string' || data instanceof Blob) {
      send(data);

      return;
    }

    const bytes = ArrayBuffer.isView(data)
      ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
      : new Uint8Array(data);

    for (let offset = 0; offset < bytes.length; offset += LARGEST_PAGE_MESSAGE) {
      send(bytes.subarray(offset, offset + LARGEST_PAGE_MESSAGE));
    }
  };

  return socket;
};
