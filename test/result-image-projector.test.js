import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { FilesystemResourceStore } from '../src/filesystem-resource-store.js';
import { MinimalHostResultImageProjector } from '../src/environment/result-image-projector.js';

const ONE_PIXEL_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

test('Minimal Host promotes provider-native result images once and removes private payload fields', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'awb-result-image-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new FilesystemResourceStore({ root });
  const projector = new MinimalHostResultImageProjector({
    resourceStore: store,
    runId: 'run-result-image',
  });
  const event = {
    type: 'item_completed',
    sessionId: 'session-result-image',
    runtimeTurnId: 'turn-result-image',
    payload: {
      item: {
        id: 'image-1',
        type: 'imageGeneration',
        status: 'completed',
        result: `data:image/png;base64,${ONE_PIXEL_PNG}`,
        savedPath: '/private/runtime/result.png',
      },
    },
  };

  const [first, retry] = await Promise.all([
    projector.projectEvent(event),
    projector.projectEvent(event),
  ]);
  assert.deepEqual(retry, first);
  assert.equal('result' in first.payload.item, false);
  assert.equal('savedPath' in first.payload.item, false);
  assert.equal(first.payload.item.publishedMedia.type, 'resourceImage');
  const resourceId = first.payload.item.publishedMedia.resourceId;
  const resource = await store.get(resourceId, { sessionId: 'session-result-image' });
  assert.equal(resource.kind, 'session-artifact');
  assert.equal(resource.owner.runId, 'run-result-image');
  assert.equal(resource.owner.turnId, 'turn-result-image');
  assert.equal(resource.display.mimeType, 'image/png');
  assert.equal(resource.lifecycle.state, 'promoted');
  assert.equal((await store.inspectUsage()).resources, 1);
  assert.deepEqual((await store.read(resourceId, { sessionId: 'session-result-image' })).bytes, Buffer.from(ONE_PIXEL_PNG, 'base64'));
});

test('Minimal Host never publishes failed or invalid generated-image payloads', async () => {
  const calls = [];
  const projector = new MinimalHostResultImageProjector({
    runId: 'run-result-image',
    resourceStore: {
      stageTransient: async (input) => { calls.push(input); return { id: 'res_transient-image' }; },
      promote: async () => { throw new Error('unexpected'); },
    },
  });
  const failed = await projector.projectEvent({
    type: 'item_completed',
    sessionId: 'session-result-image',
    runtimeTurnId: 'turn-failed',
    payload: { item: {
      id: 'image-failed',
      type: 'imageGeneration',
      status: 'failed',
      failure: 'provider rejected the image',
      result: ONE_PIXEL_PNG,
      saved_path: '/private/runtime/failed.png',
    } },
  });
  assert.equal('result' in failed.payload.item, false);
  assert.equal('saved_path' in failed.payload.item, false);
  assert.equal('publishedMedia' in failed.payload.item, false);
  assert.equal(calls.length, 0);

  const invalid = await projector.projectEvent({
    type: 'item_completed',
    sessionId: 'session-result-image',
    runtimeTurnId: 'turn-invalid',
    payload: { item: {
      id: 'image-invalid',
      type: 'imageGeneration',
      status: 'completed',
      result: 'not base64!',
    } },
  });
  assert.equal(invalid.payload.item.publicationError.code, 'RESULT_IMAGE_DATA_INVALID');
  assert.equal(calls.length, 0);

  const bounded = new MinimalHostResultImageProjector({
    runId: 'run-result-image',
    maxBytes: 4,
    resourceStore: {
      stageTransient: async (input) => { calls.push(input); return { id: 'res_transient-image' }; },
      promote: async () => { throw new Error('unexpected'); },
    },
  });
  const tooLarge = await bounded.projectEvent({
    type: 'item_completed',
    sessionId: 'session-result-image',
    runtimeTurnId: 'turn-too-large',
    payload: { item: {
      id: 'image-too-large',
      type: 'imageGeneration',
      status: 'completed',
      result: ONE_PIXEL_PNG,
    } },
  });
  assert.equal(tooLarge.payload.item.publicationError.code, 'RESULT_IMAGE_TOO_LARGE');
  assert.equal(calls.length, 0);
});
