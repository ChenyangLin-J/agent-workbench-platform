import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MAX_SESSION_ATTACHMENTS,
  MAX_SESSION_ATTACHMENT_BYTES,
  createAttachmentEnvelopeInput,
  normalizeAttachmentPolicy,
  normalizeSessionAttachment,
  parseAttachmentEnvelopes,
  sessionItemAttachmentPresentation,
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
    sessionStatus: false,
    steer: false,
    subagents: 'summary',
    sideChats: 'full',
    technicalDetails: true,
  }), {
    attachments: 'hidden',
    externalLink: 'visible',
    realtime: 'visible',
    sessionStatus: false,
    messageEdit: true,
    messageFork: true,
    queuedTurns: true,
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
  assert.deepEqual(normalizeSessionAttachment({
    id: 'upload-1', name: 'report.md', status: 'error', progress: 130, error: '网络中断',
  }), {
    id: 'upload-1', name: 'report.md', mimeType: 'application/octet-stream', size: 0,
    kind: 'file', inputType: 'mention', status: 'error', progress: 100, error: '网络中断',
  });
  const directory = normalizeSessionAttachment({
    id: 'res_directory-0001',
    name: 'Spoofed name',
    mimeType: 'application/octet-stream',
    size: 99,
    resource: {
      schema: 'agent-workbench.resource/v1',
      id: 'res_directory-0001',
      kind: 'workspace-directory',
      mode: 'external',
      owner: { sessionId: 'session-a' },
      display: { name: 'Project', mimeType: 'inode/directory', size: 0 },
      origin: { type: 'workspace', createdAt: '2026-09-01T00:00:00.000Z' },
      lifecycle: { class: 'workspace', state: 'ready', updatedAt: '2026-09-01T00:00:00.000Z' },
      capabilities: { preview: false, download: false, openInWorkspace: true },
    },
  });
  assert.equal(directory.name, 'Project');
  assert.equal(directory.mimeType, 'inode/directory');
  assert.equal(directory.size, 0);
  assert.equal(directory.kind, 'directory');
  assert.equal(directory.inputType, 'mention');
  assert.equal(directory.resource.kind, 'workspace-directory');
});

test('attachment envelopes preserve Agent input while projecting transcript attachment cards', () => {
  const input = createAttachmentEnvelopeInput({ name: '粘贴文本.txt', kind: 'text', content: '唯一测试内容' });
  const parsed = parseAttachmentEnvelopes(`请总结\n${input.text}`, { fallbackId: 'message' });
  assert.equal(parsed.text, '请总结');
  assert.deepEqual(parsed.attachments, [{
    id: 'message-0',
    name: '粘贴文本.txt',
    kind: 'file',
    sourceKind: 'text',
  }]);
  const legacy = sessionItemAttachmentPresentation({
    id: 'legacy',
    content: [{ type: 'text', text: '<personal-workbench-attachment name="old.txt" kind="file">legacy</personal-workbench-attachment>' }],
  });
  assert.equal(legacy.text, '');
  assert.equal(legacy.attachments[0].name, 'old.txt');

  const rich = createAttachmentEnvelopeInput({
    id: 'attachment-123',
    name: '粘贴内容.md',
    kind: 'text',
    mimeType: 'text/markdown',
    size: 42,
    content: '## 标题',
  });
  assert.deepEqual(parseAttachmentEnvelopes(rich.text).attachments, [{
    id: 'attachment-123',
    name: '粘贴内容.md',
    kind: 'file',
    sourceKind: 'text',
    mimeType: 'text/markdown',
    size: 42,
  }]);
});
