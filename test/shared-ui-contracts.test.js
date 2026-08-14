import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MAX_SESSION_ATTACHMENTS,
  MAX_SESSION_ATTACHMENT_BYTES,
  normalizeAttachmentPolicy,
  normalizeSessionAttachment,
  sessionAttachmentKind,
  validateSessionAttachment,
} from '../src/attachments.js';
import {
  normalizeSessionFeatures,
  normalizeSideChatMode,
  normalizeSubagentMode,
  normalizeVisibility,
} from '../src/capabilities.js';

test('Session capabilities preserve booleans and support product UI complexity modes', () => {
  assert.equal(normalizeSubagentMode(true), 'full');
  assert.equal(normalizeSubagentMode('summary'), 'summary');
  assert.equal(normalizeSubagentMode('unsupported'), 'hidden');
  assert.equal(normalizeSideChatMode(true), 'full');
  assert.equal(normalizeVisibility(true), 'visible');
  assert.deepEqual(normalizeSessionFeatures({
    attachments: false,
    realtimeV3: true,
    steer: false,
    subagents: 'summary',
    sideChats: 'full',
    technicalDetails: true,
  }), {
    attachments: 'hidden',
    externalLink: 'visible',
    realtime: 'visible',
    steer: false,
    sideChats: 'full',
    subagents: 'summary',
    technicalDetails: true,
  });
});

test('attachment contract normalizes UI metadata without taking over product storage', () => {
  assert.equal(MAX_SESSION_ATTACHMENTS, 5);
  assert.equal(MAX_SESSION_ATTACHMENT_BYTES, 20 * 1024 * 1024);
  assert.equal(sessionAttachmentKind({ mimeType: 'application/octet-stream', name: 'voice.m4a' }), 'audio');
  assert.deepEqual(normalizeSessionAttachment({
    id: 'file-1', name: 'chart.png', mimeType: 'image/png', size: 42, storedPath: '/private/product-path',
  }), {
    id: 'file-1', name: 'chart.png', mimeType: 'image/png', size: 42,
    kind: 'image', inputType: 'localImage', status: 'ready',
  });
  assert.deepEqual(normalizeAttachmentPolicy({ maxCount: 3 }), {
    maxCount: 3, maxBytes: MAX_SESSION_ATTACHMENT_BYTES, accept: '',
  });
  assert.deepEqual(validateSessionAttachment({ name: 'large.pdf', size: 101 }, { maxBytes: 100 }), {
    ok: false,
    attachment: {
      id: 'attachment', name: 'large.pdf', mimeType: 'application/octet-stream', size: 101,
      kind: 'file', inputType: 'mention', status: 'ready',
    },
    reason: 'too_large', maxBytes: 100,
  });
});
