import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

import { EnvironmentSessionStore } from '../src/environment/session-store.js';

const sessionCount = positiveInteger(process.argv[2], 120);
const deltaCount = positiveInteger(process.argv[3], 500);
const root = await mkdtemp(join(tmpdir(), 'awb-session-benchmark-'));

try {
  const legacy = legacyDocument(sessionCount);
  const legacyText = `${JSON.stringify(legacy, null, 2)}\n`;
  await writeFile(join(root, 'sessions.json'), legacyText, { mode: 0o600 });
  const migrationStarted = performance.now();
  const store = new EnvironmentSessionStore({ stateRoot: root });
  await store.ready;
  const migrationMs = performance.now() - migrationStarted;

  const v2BytesBefore = await directoryBytes(root, { exclude: new Set(['sessions.json']) });
  const streamStarted = performance.now();
  await Promise.all(Array.from({ length: deltaCount }, (_, index) => store.applyEvent({
    type: 'item_delta',
    sessionId: 'session-0000',
    runtimeTurnId: 'turn-benchmark',
    providerEvent: 'item/agentMessage/delta',
    createdAt: Date.now() + index,
    payload: { itemId: 'answer-benchmark', delta: 'abcdefghij' },
  })));
  const streamMs = performance.now() - streamStarted;
  const v2BytesAfter = await directoryBytes(root, { exclude: new Set(['sessions.json']) });

  const listStarted = performance.now();
  for (let index = 0; index < 100; index += 1) await store.listPage({ limit: 50 });
  const listAverageMs = (performance.now() - listStarted) / 100;
  const detailStarted = performance.now();
  for (let index = 0; index < 25; index += 1) await store.get('session-0000');
  const detailAverageMs = (performance.now() - detailStarted) / 25;
  await store.close();

  process.stdout.write(`${JSON.stringify({
    sessions: sessionCount,
    deltas: deltaCount,
    legacyDocumentBytes: Buffer.byteLength(legacyText),
    legacyRewriteEstimateBytes: Buffer.byteLength(legacyText) * deltaCount,
    v2IncrementalBytes: v2BytesAfter - v2BytesBefore,
    migrationMs: round(migrationMs),
    streamBatchMs: round(streamMs),
    listPageAverageMs: round(listAverageMs),
    selectedDetailAverageMs: round(detailAverageMs),
    rssBytes: process.memoryUsage().rss,
  }, null, 2)}\n`);
} finally {
  await rm(root, { recursive: true, force: true });
}

function legacyDocument(count) {
  const sessions = {};
  const content = 'x'.repeat(32 * 1024);
  for (let index = 0; index < count; index += 1) {
    const id = `session-${String(index).padStart(4, '0')}`;
    const timestamp = new Date(1_800_000_000_000 + index * 1_000).toISOString();
    sessions[id] = {
      id,
      ownerId: 'benchmark-owner',
      title: `Benchmark ${index}`,
      status: 'idle',
      createdAt: timestamp,
      updatedAt: timestamp,
      completedAt: null,
      messages: [{
        id: `message-${index}`,
        role: 'assistant',
        phase: 'answer',
        content,
        turnId: `turn-${index}`,
        turnStatus: 'completed',
        createdAt: timestamp,
      }],
      technicalItems: [],
      plan: [],
    };
  }
  return { version: 1, sessions, bindings: {}, queuedTurns: {} };
}

async function directoryBytes(root, { exclude = new Set() } = {}) {
  let bytes = 0;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (exclude.has(entry.name)) continue;
    const path = join(root, entry.name);
    bytes += entry.isDirectory() ? await directoryBytes(path) : (await stat(path)).size;
  }
  return bytes;
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
}

function round(value) {
  return Math.round(value * 100) / 100;
}
