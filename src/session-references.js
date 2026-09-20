export const SESSION_REFERENCE_KIND = 'session';
export const SESSION_REFERENCE_VERSION = 1;
export const SESSION_REFERENCE_DRAG_MIME = 'application/x-agent-workbench-session-reference+json';
export const MAX_SESSION_REFERENCES = 8;

const ID_LIMIT = 200;
const LABEL_LIMIT = 240;
const DRAG_BYTES_LIMIT = 4096;
const REFERENCE_ENVELOPE_TAG = 'agent-workbench-session-references';

function boundedText(value, limit) {
  return String(value ?? '').trim().slice(0, limit);
}

function normalizedTimestamp(value) {
  if (value == null || value === '') return 0;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric < 1e12 ? numeric * 1000 : numeric;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

export function sessionReferenceKey(reference = {}) {
  const hostId = boundedText(reference.hostId, ID_LIMIT);
  const threadId = boundedText(reference.threadId, ID_LIMIT);
  return hostId && threadId ? `${hostId}:${threadId}` : '';
}

export function normalizeSessionReference(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const kind = value.kind == null ? SESSION_REFERENCE_KIND : String(value.kind);
  const version = value.version == null ? SESSION_REFERENCE_VERSION : Number(value.version);
  const hostId = boundedText(value.hostId, ID_LIMIT);
  const threadId = boundedText(value.threadId, ID_LIMIT);
  if (kind !== SESSION_REFERENCE_KIND || version !== SESSION_REFERENCE_VERSION || !hostId || !threadId) return null;
  return {
    kind: SESSION_REFERENCE_KIND,
    version: SESSION_REFERENCE_VERSION,
    hostId,
    threadId,
    label: boundedText(value.label || '未命名 Session', LABEL_LIMIT) || '未命名 Session',
    contextLabel: boundedText(value.contextLabel, LABEL_LIMIT),
    updatedAt: normalizedTimestamp(value.updatedAt),
    archived: Boolean(value.archived),
    unavailable: Boolean(value.unavailable),
  };
}

export function normalizeSessionReferences(values, { maximum = MAX_SESSION_REFERENCES } = {}) {
  const result = [];
  const keys = new Set();
  const limit = Math.max(0, Math.min(MAX_SESSION_REFERENCES, Number(maximum) || MAX_SESSION_REFERENCES));
  for (const value of Array.isArray(values) ? values : []) {
    const reference = normalizeSessionReference(value);
    const key = sessionReferenceKey(reference);
    if (!reference || !key || keys.has(key)) continue;
    keys.add(key);
    result.push(reference);
    if (result.length >= limit) break;
  }
  return result;
}

export function encodeSessionReferenceDrag(reference) {
  const normalized = normalizeSessionReference(reference);
  if (!normalized) return '';
  const serialized = JSON.stringify(normalized);
  return new TextEncoder().encode(serialized).byteLength <= DRAG_BYTES_LIMIT ? serialized : '';
}

export function dataTransferHasSessionReference(dataTransfer) {
  return Array.from(dataTransfer?.types || []).includes(SESSION_REFERENCE_DRAG_MIME);
}

export function sessionReferenceFromDataTransfer(dataTransfer) {
  if (!dataTransferHasSessionReference(dataTransfer)) return null;
  try {
    const serialized = String(dataTransfer?.getData?.(SESSION_REFERENCE_DRAG_MIME) || '');
    if (!serialized || new TextEncoder().encode(serialized).byteLength > DRAG_BYTES_LIMIT) return null;
    return normalizeSessionReference(JSON.parse(serialized));
  } catch {
    return null;
  }
}

export function setSessionReferenceDataTransfer(dataTransfer, reference) {
  const serialized = encodeSessionReferenceDrag(reference);
  if (!serialized || !dataTransfer?.setData) return false;
  dataTransfer.setData(SESSION_REFERENCE_DRAG_MIME, serialized);
  dataTransfer.effectAllowed = 'link';
  return true;
}

export function composerSessionMention(value, selectionStart = String(value ?? '').length) {
  const text = String(value ?? '');
  const cursor = Math.max(0, Math.min(text.length, Number(selectionStart) || 0));
  const lineStart = text.lastIndexOf('\n', cursor - 1) + 1;
  const beforeCursor = text.slice(lineStart, cursor);
  const match = beforeCursor.match(/(^|\s)@([^@\n]{0,80})$/u);
  if (!match) return null;
  const start = lineStart + match.index + match[1].length;
  return { start, end: cursor, query: match[2].trim() };
}

export function removeComposerSessionMention(value, mention) {
  const text = String(value ?? '');
  if (!mention || mention.start < 0 || mention.end < mention.start || mention.end > text.length) return text;
  return `${text.slice(0, mention.start)}${text.slice(mention.end)}`.replace(/[ \t]{2,}/g, ' ');
}

export function createSessionReferenceEnvelopeInput(values) {
  const references = normalizeSessionReferences(values).map(({ hostId, threadId, label, contextLabel }) => ({
    hostId,
    threadId,
    label,
    contextLabel,
  }));
  if (!references.length) return null;
  return {
    type: 'text',
    text: `<${REFERENCE_ENVELOPE_TAG}>\n${JSON.stringify(references)}\n</${REFERENCE_ENVELOPE_TAG}>`,
  };
}

export function parseSessionReferenceEnvelopes(value = '') {
  const references = [];
  const pattern = new RegExp(`\\n?<${REFERENCE_ENVELOPE_TAG}>([\\s\\S]*?)<\\/${REFERENCE_ENVELOPE_TAG}>\\n?`, 'g');
  const text = String(value || '').replace(pattern, (_match, serialized) => {
    try {
      references.push(...normalizeSessionReferences(JSON.parse(serialized)));
    } catch {
      // Malformed envelopes stay hidden and never become authorized references.
    }
    return '\n';
  }).replace(/^\s+|\s+$/g, '').replace(/\n{3,}/g, '\n\n');
  return { text, references: normalizeSessionReferences(references) };
}
