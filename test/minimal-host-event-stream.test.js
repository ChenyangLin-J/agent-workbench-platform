import assert from 'node:assert/strict';
import test from 'node:test';

import {
  maintainMinimalHostEventStream,
  readMinimalHostEventStream,
} from '../src/environment/host-event-stream.js';

test('Minimal Host event stream parses fragmented CRLF events and resumes from the last id', async () => {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(': connected\r\n\r\nid: 7\r\nda'));
      controller.enqueue(encoder.encode('ta: {"type":"item_started"}\r\n\r\n'));
      controller.close();
    },
  });
  const events = [];
  const result = await readMinimalHostEventStream(body, { onEvent: (event) => events.push(event) });
  assert.deepEqual(events, [{ eventId: 7, data: '{"type":"item_started"}' }]);
  assert.deepEqual(result, { eventCount: 1, lastEventId: 7 });
});

test('Minimal Host event stream reconnects after failure and requests replay after the last event', async () => {
  const controller = new AbortController();
  const calls = [];
  const waits = [];
  const events = [];
  const open = async ({ afterEventId }) => {
    calls.push(afterEventId);
    if (calls.length === 1) return new Response('', { status: 502 });
    if (calls.length === 2) {
      return new Response('id: 12\ndata: {"type":"turn_completed"}\n\n', {
        headers: { 'content-type': 'text/event-stream' },
      });
    }
    controller.abort();
    throw Object.assign(new Error('aborted'), { name: 'AbortError' });
  };
  await maintainMinimalHostEventStream({
    open,
    onEvent: (event) => events.push(event),
    signal: controller.signal,
    wait: async (delayMs) => waits.push(delayMs),
  });
  assert.deepEqual(calls, [0, 0, 12]);
  assert.deepEqual(waits, [500, 500]);
  assert.deepEqual(events, [{ eventId: 12, data: '{"type":"turn_completed"}' }]);
});
