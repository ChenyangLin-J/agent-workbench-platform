import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';

import {
  TEXT_PREVIEW_MAX_BYTES,
  decodeUtf8Preview,
  filePreviewFormat,
  formatSqlPreview,
  parseCsvPreview,
} from '../file-preview.js';

export async function createSessionAttachmentPreview(attachment, { maxTextBytes = TEXT_PREVIEW_MAX_BYTES } = {}) {
  const format = filePreviewFormat(attachment);
  const base = {
    resourceId: attachment.id,
    name: attachment.name,
    mimeType: attachment.mimeType,
    size: attachment.size,
    digest: attachment.resource?.integrity?.digest || null,
    format,
    modes: previewModes(format),
  };
  if (format === 'unsupported') return base;

  let rawText = null;
  let rawError = null;
  if (attachment.size <= maxTextBytes) {
    try {
      rawText = decodeUtf8Preview(await readFile(attachment.storedPath), { maxBytes: maxTextBytes });
    } catch (error) {
      rawError = safePreviewError(error);
    }
  } else {
    rawError = { code: 'PREVIEW_TOO_LARGE', message: '文件过大，无法显示 Raw；可下载原文件。' };
  }

  if (format !== 'csv') {
    return {
      ...base,
      rawAvailable: rawText != null,
      ...(rawText != null ? { rawText } : {}),
      ...(rawError ? { rawError } : {}),
      ...(format === 'sql' && rawText != null ? { formattedText: formatSqlPreview(rawText) } : {}),
    };
  }

  let csv = null;
  let csvError = null;
  try {
    csv = await parseCsvPreview(createReadStream(attachment.storedPath));
  } catch (error) {
    csvError = safePreviewError(error);
  }
  return {
    ...base,
    rawAvailable: rawText != null,
    ...(rawText != null ? { rawText } : {}),
    ...(rawError ? { rawError } : {}),
    ...(csv ? { csv } : {}),
    ...(csvError ? { csvError } : {}),
  };
}

function previewModes(format) {
  return ({
    markdown: ['preview', 'raw'],
    sql: ['formatted', 'raw'],
    csv: ['table', 'raw'],
    text: ['raw'],
  })[format] || [];
}

function safePreviewError(error) {
  const code = String(error?.code || 'PREVIEW_FAILED');
  const record = String(error?.message || '').match(/record (\d+)/i)?.[1];
  const messages = {
    CSV_FIELD_TOO_LARGE: 'CSV 单元格过大，无法生成表格预览。',
    CSV_PARSE_FAILED: 'CSV 格式有误，无法生成表格预览。',
    CSV_TOO_WIDE: 'CSV 列数过多，无法生成表格预览。',
    PREVIEW_ENCODING_UNSUPPORTED: '文件不是有效的 UTF-8 文本。',
    PREVIEW_TOO_LARGE: '文件过大，无法显示 Raw；可下载原文件。',
  };
  return {
    code,
    message: `${messages[code] || '无法生成文件预览。'}${record ? `（记录 ${record}）` : ''}`,
  };
}
