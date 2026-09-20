import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MAX_SESSION_REFERENCES,
  SESSION_REFERENCE_DRAG_MIME,
  composerSessionMention,
  dataTransferHasSessionReference,
  normalizeSessionReference,
  normalizeSessionReferences,
  removeComposerSessionMention,
  sessionReferenceFromDataTransfer,
  sessionReferenceKey,
  setSessionReferenceDataTransfer,
} from '../src/session-references.js';

function reference(threadId, overrides = {}) {
  return {
    kind: 'session', version: 1, hostId: 'personal-local', threadId,
    label: `Session ${threadId}`, contextLabel: 'Project', ...overrides,
  };
}

test('Session references use host and thread identity with bounded display metadata', () => {
  const normalized = normalizeSessionReference(reference('thread-1', {
    label: ` ${'x'.repeat(300)} `,
    updatedAt: 1_700_000_000,
  }));
  assert.equal(sessionReferenceKey(normalized), 'personal-local:thread-1');
  assert.equal(normalized.label.length, 240);
  assert.equal(normalized.updatedAt, 1_700_000_000_000);
  assert.equal(normalizeSessionReference({ hostId: 'host-only' }), null);
  assert.equal(normalizeSessionReference({ ...reference('t'), version: 2 }), null);
});

test('Session reference collections deduplicate identity and cap each Turn', () => {
  const values = [reference('same'), reference('same', { label: 'renamed' })];
  for (let index = 0; index < MAX_SESSION_REFERENCES + 4; index += 1) values.push(reference(`thread-${index}`));
  const normalized = normalizeSessionReferences(values);
  assert.equal(normalized.length, MAX_SESSION_REFERENCES);
  assert.equal(normalized[0].label, 'Session same');
  assert.equal(new Set(normalized.map(sessionReferenceKey)).size, normalized.length);
});

test('Session reference drag payload round-trips through its dedicated MIME', () => {
  const values = new Map();
  const dataTransfer = {
    types: [],
    setData(type, value) { values.set(type, value); this.types.push(type); },
    getData(type) { return values.get(type) || ''; },
  };
  assert.equal(setSessionReferenceDataTransfer(dataTransfer, reference('dragged')), true);
  assert.equal(dataTransfer.effectAllowed, 'link');
  assert.equal(dataTransferHasSessionReference(dataTransfer), true);
  assert.equal(dataTransfer.types.includes(SESSION_REFERENCE_DRAG_MIME), true);
  assert.deepEqual(sessionReferenceFromDataTransfer(dataTransfer), normalizeSessionReference(reference('dragged')));
  values.set(SESSION_REFERENCE_DRAG_MIME, '{not-json');
  assert.equal(sessionReferenceFromDataTransfer(dataTransfer), null);
});

test('Composer mention parsing keeps references separate from editable text', () => {
  const value = '请核对 @渠道归因';
  const mention = composerSessionMention(value, value.length);
  assert.deepEqual(mention, { start: 4, end: value.length, query: '渠道归因' });
  assert.equal(removeComposerSessionMention(value, mention), '请核对 ');
  assert.equal(composerSessionMention('mail@example.com'), null);
  assert.deepEqual(composerSessionMention('第一行\n@归档'), { start: 4, end: 7, query: '归档' });
});
