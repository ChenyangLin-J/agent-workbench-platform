export const MAX_SESSION_ATTACHMENTS = 5;
export const MAX_SESSION_ATTACHMENT_BYTES = 20 * 1024 * 1024;

export function sessionAttachmentKind({ mimeType = '', name = '', path = '' } = {}) {
  const normalizedMime = String(mimeType || '').trim().toLowerCase();
  const fileName = String(name || path || '').trim();
  if (isAudioAttachment(normalizedMime, fileName)) return 'audio';
  if (normalizedMime.startsWith('image/')) return 'image';
  return 'file';
}

export function normalizeSessionAttachment(value = {}, fallbackId = 'attachment') {
  const name = String(value.name || '附件');
  const mimeType = String(value.mimeType || 'application/octet-stream').toLowerCase();
  const kind = sessionAttachmentKind({ mimeType, name, path: value.path || value.storedPath });
  return {
    id: String(value.id || fallbackId),
    name,
    mimeType,
    size: nonNegativeNumber(value.size),
    kind,
    inputType: value.inputType || inputTypeForKind(kind),
    status: ['uploading', 'ready', 'error'].includes(value.status) ? value.status : 'ready',
    ...(value.previewUrl ? { previewUrl: String(value.previewUrl) } : {}),
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

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

