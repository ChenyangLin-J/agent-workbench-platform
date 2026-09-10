import { format } from 'sql-formatter';

export const TEXT_PREVIEW_MAX_BYTES = 1024 * 1024;
export const CSV_PREVIEW_MAX_ROWS = 200;
export const CSV_PREVIEW_MAX_COLUMNS = 200;
export const CSV_PREVIEW_MAX_FIELD_BYTES = 64 * 1024;

const TEXT_MIME_TYPES = new Set([
  'application/sql',
  'text/csv',
  'text/markdown',
  'text/plain',
  'text/sql',
  'text/x-markdown',
  'text/x-sql',
]);

const SQL_KEYWORDS = new Set([
  'all', 'and', 'as', 'asc', 'between', 'by', 'case', 'cast', 'cross', 'current', 'date', 'delete', 'desc',
  'distinct', 'else', 'end', 'except', 'exists', 'extract', 'false', 'following', 'from', 'full', 'group',
  'having', 'if', 'in', 'inner', 'insert', 'intersect', 'interval', 'into', 'is', 'join', 'left', 'limit',
  'merge', 'not', 'null', 'nulls', 'on', 'or', 'order', 'outer', 'over', 'partition', 'preceding', 'qualify',
  'range', 'recursive', 'replace', 'right', 'rows', 'select', 'set', 'struct', 'then', 'true', 'union',
  'unnest', 'update', 'using', 'values', 'when', 'where', 'window', 'with',
]);

export function formatSqlPreview(content, options = {}) {
  const source = String(content ?? '');
  if (!source.trim()) return source;
  try {
    return format(source, {
      language: options.language || 'bigquery',
      keywordCase: options.keywordCase || 'upper',
      tabWidth: options.tabWidth || 2,
      linesBetweenQueries: options.linesBetweenQueries ?? 2,
    });
  } catch {
    return source;
  }
}

export function filePreviewFormat({ name = '', mimeType = '' } = {}) {
  const extension = String(name).toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] || '';
  const normalizedMime = String(mimeType).split(';', 1)[0].trim().toLowerCase();
  if (extension === 'md' || ['text/markdown', 'text/x-markdown'].includes(normalizedMime)) return 'markdown';
  if (extension === 'sql' || ['application/sql', 'text/sql', 'text/x-sql'].includes(normalizedMime)) return 'sql';
  if (extension === 'csv' || normalizedMime === 'text/csv') return 'csv';
  if (extension === 'txt' || normalizedMime === 'text/plain') return 'text';
  return TEXT_MIME_TYPES.has(normalizedMime) ? 'text' : 'unsupported';
}

export function decodeUtf8Preview(bytes, { maxBytes = TEXT_PREVIEW_MAX_BYTES } = {}) {
  const content = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || []);
  if (content.length > maxBytes) {
    throw previewError('PREVIEW_TOO_LARGE', 'File is too large for Raw preview.', 413);
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(content).replace(/^\uFEFF/, '');
  } catch {
    throw previewError('PREVIEW_ENCODING_UNSUPPORTED', 'File is not valid UTF-8 text.', 415);
  }
}

export async function parseCsvPreview(source, {
  maxRows = CSV_PREVIEW_MAX_ROWS,
  maxColumns = CSV_PREVIEW_MAX_COLUMNS,
  maxFieldBytes = CSV_PREVIEW_MAX_FIELD_BYTES,
} = {}) {
  if (!Number.isSafeInteger(maxRows) || maxRows < 1) throw new TypeError('CSV maxRows must be positive');
  if (!Number.isSafeInteger(maxColumns) || maxColumns < 1) throw new TypeError('CSV maxColumns must be positive');
  if (!Number.isSafeInteger(maxFieldBytes) || maxFieldBytes < 1) throw new TypeError('CSV maxFieldBytes must be positive');
  const records = [];
  let row = [];
  let field = '';
  let fieldBytes = 0;
  let fieldStarted = false;
  let inQuotes = false;
  let quotePending = false;
  let skipLf = false;
  let sawContent = false;
  let recordNumber = 1;
  let hasMore = false;
  const decoder = new TextDecoder('utf-8', { fatal: true });

  function append(character) {
    fieldStarted = true;
    fieldBytes += Buffer.byteLength(character);
    if (fieldBytes > maxFieldBytes) {
      throw previewError('CSV_FIELD_TOO_LARGE', `CSV field exceeds the limit at record ${recordNumber}.`, 422);
    }
    field += character;
  }

  function pushField() {
    row.push(field);
    field = '';
    fieldBytes = 0;
    fieldStarted = false;
    if (row.length > maxColumns) {
      throw previewError('CSV_TOO_WIDE', `CSV has too many columns at record ${recordNumber}.`, 422);
    }
  }

  function pushRecord() {
    pushField();
    records.push(row);
    row = [];
    recordNumber += 1;
    if (records.length > maxRows + 1) hasMore = true;
  }

  function consume(text) {
    for (const character of text) {
      sawContent = true;
      if (skipLf) {
        skipLf = false;
        if (character === '\n') continue;
      }
      if (inQuotes) {
        if (quotePending) {
          if (character === '"') {
            append('"');
            quotePending = false;
            continue;
          }
          inQuotes = false;
          quotePending = false;
          if (![',', '\r', '\n'].includes(character)) {
            throw previewError('CSV_PARSE_FAILED', `CSV quoted field is invalid at record ${recordNumber}.`, 422);
          }
        } else if (character === '"') {
          quotePending = true;
          continue;
        } else {
          append(character);
          continue;
        }
      }
      if (character === ',') pushField();
      else if (character === '\n') pushRecord();
      else if (character === '\r') {
        pushRecord();
        skipLf = true;
      } else if (character === '"') {
        if (fieldStarted) {
          throw previewError('CSV_PARSE_FAILED', `CSV quote is invalid at record ${recordNumber}.`, 422);
        }
        fieldStarted = true;
        inQuotes = true;
      } else append(character);
      if (hasMore) return false;
    }
    return true;
  }

  try {
    for await (const chunk of csvChunks(source)) {
      if (!consume(decoder.decode(chunk, { stream: true }))) break;
    }
    if (!hasMore) consume(decoder.decode());
  } catch (error) {
    if (error?.code) throw error;
    throw previewError('PREVIEW_ENCODING_UNSUPPORTED', 'File is not valid UTF-8 text.', 415);
  }
  if (!hasMore) {
    if (inQuotes && !quotePending) {
      throw previewError('CSV_PARSE_FAILED', `CSV quoted field is not closed at record ${recordNumber}.`, 422);
    }
    if (quotePending) {
      inQuotes = false;
      quotePending = false;
    }
    if (sawContent && (fieldStarted || row.length)) pushRecord();
  }
  const header = records.shift() || [];
  const rows = records.slice(0, maxRows);
  const width = Math.max(header.length, ...rows.map((candidate) => candidate.length), 0);
  const seen = new Set();
  const headers = Array.from({ length: width }, (_, index) => {
    const candidate = String(header[index] ?? '');
    const key = candidate.trim().toLocaleLowerCase();
    if (!key || seen.has(key)) return `Column ${index + 1}`;
    seen.add(key);
    return candidate;
  });
  return {
    headers,
    rows: rows.map((candidate) => Array.from({ length: width }, (_, index) => String(candidate[index] ?? ''))),
    previewedRows: rows.length,
    hasMore,
  };
}

export function tokenizeSqlPreview(content) {
  const source = String(content ?? '');
  const tokens = [];
  let index = 0;
  const push = (type, start, end) => tokens.push({ type, text: source.slice(start, end) });
  while (index < source.length) {
    const start = index;
    if (/\s/.test(source[index])) {
      while (index < source.length && /\s/.test(source[index])) index += 1;
      push('plain', start, index);
    } else if (source.startsWith('--', index)) {
      index = source.indexOf('\n', index);
      if (index < 0) index = source.length;
      push('comment', start, index);
    } else if (source.startsWith('/*', index)) {
      const end = source.indexOf('*/', index + 2);
      index = end < 0 ? source.length : end + 2;
      push('comment', start, index);
    } else if (["'", '"', '`'].includes(source[index])) {
      const quote = source[index++];
      while (index < source.length) {
        if (source[index] === quote) {
          if (source[index + 1] === quote && quote !== '`') index += 2;
          else { index += 1; break; }
        } else if (source[index] === '\\' && quote !== '`') index += Math.min(2, source.length - index);
        else index += 1;
      }
      push(quote === "'" ? 'string' : 'identifier', start, index);
    } else if (source[index] === '@' || source[index] === '?') {
      index += 1;
      while (index < source.length && /[\w.]/u.test(source[index])) index += 1;
      push('parameter', start, index);
    } else if (/\d/.test(source[index])) {
      index += 1;
      while (index < source.length && /[\d.eE_+-]/.test(source[index])) index += 1;
      push('number', start, index);
    } else if (/[\p{Letter}_]/u.test(source[index])) {
      index += 1;
      while (index < source.length && /[\p{Letter}\p{Number}_$]/u.test(source[index])) index += 1;
      const word = source.slice(start, index);
      const following = source.slice(index).match(/^\s*\(/);
      push(SQL_KEYWORDS.has(word.toLowerCase()) ? 'keyword' : following ? 'function' : 'identifier', start, index);
    } else {
      index += 1;
      push('plain', start, index);
    }
  }
  return tokens;
}

async function* csvChunks(source) {
  if (source == null) return;
  if (typeof source === 'string' || Buffer.isBuffer(source) || source instanceof Uint8Array) {
    yield Buffer.from(source);
    return;
  }
  if (typeof source[Symbol.asyncIterator] === 'function') {
    for await (const chunk of source) yield Buffer.from(chunk);
    return;
  }
  throw new TypeError('CSV source must be bytes, text, or an async iterable');
}

function previewError(code, message, status) {
  return Object.assign(new Error(message), { code, status });
}
