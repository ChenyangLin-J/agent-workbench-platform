import { normalizeResourceDescriptor } from './resources.js';

export const MAX_SESSION_ATTACHMENTS = 5;
export const MAX_SESSION_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const MAX_INLINE_TEXT_ATTACHMENT_BYTES = 512 * 1024;

const ATTACHMENT_ENVELOPE_TAG = 'agent-workbench-attachment';
const ATTACHMENT_ENVELOPE_TAGS = '(?:agent-workbench|personal-workbench)-attachment';

export function sessionAttachmentKind({ mimeType = '', name = '', path = '', resourceKind = '' } = {}) {
  if (resourceKind === 'workspace-directory') return 'directory';
  const normalizedMime = String(mimeType || '').trim().toLowerCase();
  const fileName = String(name || path || '').trim();
  if (isAudioAttachment(normalizedMime, fileName)) return 'audio';
  if (normalizedMime.startsWith('image/')) return 'image';
  return 'file';
}

export function normalizeSessionAttachment(value = {}, fallbackId = 'attachment') {
  const resource = normalizedResource(value.resource);
  const name = String(resource?.display.name || value.name || '附件');
  const mimeType = String(resource?.display.mimeType || value.mimeType || 'application/octet-stream').toLowerCase();
  const size = resource?.display.size ?? value.size;
  const kind = sessionAttachmentKind({
    mimeType,
    name,
    path: value.path || value.storedPath,
    resourceKind: resource?.kind,
  });
  const progress = value.progress == null ? Number.NaN : Number(value.progress);
  return {
    id: String(resource?.id || value.id || fallbackId),
    name,
    mimeType,
    size: nonNegativeNumber(size),
    kind,
    inputType: value.inputType || inputTypeForKind(kind),
    status: ['uploading', 'ready', 'error'].includes(value.status) ? value.status : 'ready',
    ...(Number.isFinite(progress) ? { progress: Math.min(100, Math.max(0, progress)) } : {}),
    ...(value.error ? { error: String(value.error) } : {}),
    ...(value.previewUrl ? { previewUrl: String(value.previewUrl) } : {}),
    ...(resource ? { resource } : {}),
  };
}

export function normalizeAttachmentPolicy(value = {}) {
  return {
    maxCount: positiveInteger(value.maxCount, MAX_SESSION_ATTACHMENTS),
    maxBytes: positiveInteger(value.maxBytes, MAX_SESSION_ATTACHMENT_BYTES),
    accept: String(value.accept || ''),
  };
}

export function validateSessionAttachment(value = {}, policy = {}) {
  const attachment = normalizeSessionAttachment(value);
  const normalizedPolicy = normalizeAttachmentPolicy(policy);
  if (attachment.size > normalizedPolicy.maxBytes) {
    return { ok: false, attachment, reason: 'too_large', maxBytes: normalizedPolicy.maxBytes };
  }
  return { ok: true, attachment };
}

export function createAttachmentEnvelopeInput({
  id = '',
  name = 'attachment',
  kind = 'file',
  mimeType = '',
  size = 0,
  content = '',
} = {}) {
  const normalizedKind = ['text', 'file', 'image', 'audio'].includes(kind) ? kind : 'file';
  const attributes = [
    id ? `id="${encodeURIComponent(String(id))}"` : '',
    `name="${encodeURIComponent(String(name || 'attachment'))}"`,
    `kind="${normalizedKind}"`,
    mimeType ? `mime="${encodeURIComponent(String(mimeType).toLowerCase())}"` : '',
    Number(size) > 0 ? `size="${Math.floor(Number(size))}"` : '',
  ].filter(Boolean).join(' ');
  return {
    type: 'text',
    text: `<${ATTACHMENT_ENVELOPE_TAG} ${attributes}>\n${String(content || '')}\n</${ATTACHMENT_ENVELOPE_TAG}>`,
  };
}

export function parseAttachmentEnvelopes(value = '', { fallbackId = 'attachment' } = {}) {
  const attachments = [];
  const text = String(value || '').replace(attachmentEnvelopePattern(), (_match, rawAttributes) => {
    const sourceKind = envelopeAttribute(rawAttributes, 'kind');
    const encodedId = envelopeAttribute(rawAttributes, 'id');
    const encodedMimeType = envelopeAttribute(rawAttributes, 'mime');
    const encodedName = envelopeAttribute(rawAttributes, 'name');
    const encodedSize = envelopeAttribute(rawAttributes, 'size');
    const attachment = {
      id: decodeAttachmentAttribute(encodedId) || `${fallbackId}-${attachments.length}`,
      name: decodeAttachmentName(encodedName),
      kind: ['image', 'audio'].includes(sourceKind) ? sourceKind : 'file',
      sourceKind: ['text', 'file', 'image', 'audio'].includes(sourceKind) ? sourceKind : 'file',
    };
    const mimeType = decodeAttachmentAttribute(encodedMimeType);
    const size = Number(encodedSize);
    if (mimeType) attachment.mimeType = mimeType.toLowerCase();
    if (Number.isFinite(size) && size > 0) attachment.size = size;
    attachments.push(attachment);
    return '\n';
  }).replace(/^\s+|\s+$/g, '').replace(/\n{3,}/g, '\n\n');
  return { text, attachments };
}

export function sessionItemAttachmentPresentation(item = {}) {
  const content = typeof item.text === 'string'
    ? item.text
    : Array.isArray(item.content)
      ? item.content.map((part) => part?.text || part?.inputText || '').filter(Boolean).join('\n')
      : '';
  return parseAttachmentEnvelopes(content, { fallbackId: String(item.id || 'message') });
}

function inputTypeForKind(kind) {
  if (kind === 'image') return 'localImage';
  if (kind === 'audio') return 'localAudio';
  return 'mention';
}

function isAudioAttachment(mimeType, fileName) {
  if (mimeType.startsWith('audio/')) return true;
  if (mimeType && mimeType !== 'application/octet-stream') return false;
  return /\.(?:aac|aif|aiff|caf|flac|m4a|mp3|oga|ogg|opus|wav|weba|webm)$/i.test(fileName);
}

function nonNegativeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function normalizedResource(value) {
  if (value == null) return null;
  try {
    return normalizeResourceDescriptor(value);
  } catch {
    return null;
  }
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function attachmentEnvelopePattern() {
  return new RegExp(`\\n?<${ATTACHMENT_ENVELOPE_TAGS}\\b([^>]*)>[\\s\\S]*?<\\/${ATTACHMENT_ENVELOPE_TAGS}>\\n?`, 'g');
}

function envelopeAttribute(attributes, name) {
  return String(attributes || '').match(new RegExp(`(?:^|\\s)${name}="([^"]*)"`))?.[1] || '';
}

function decodeAttachmentAttribute(value) {
  try {
    return decodeURIComponent(String(value || ''));
  } catch {
    return '';
  }
}

function decodeAttachmentName(value) {
  return decodeAttachmentAttribute(value) || 'attachment';
}
