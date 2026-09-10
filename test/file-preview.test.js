import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decodeUtf8Preview,
  filePreviewFormat,
  formatSqlPreview,
  parseCsvPreview,
  tokenizeSqlPreview,
} from '../src/file-preview.js';

test('SQL preview formatting is product-neutral and preserves string values', () => {
  const formatted = formatSqlPreview("select user_id,count(*) as total from events where event_name='select from' group by user_id");
  assert.match(formatted, /^SELECT\n  user_id,/);
  assert.match(formatted, /count\(\*\) AS total/);
  assert.match(formatted, /FROM\n  events/);
  assert.match(formatted, /event_name = 'select from'/);
  assert.match(formatted, /GROUP BY\n  user_id$/);
});

test('SQL preview formatting supports consumer dialect overrides and safe fallback input', () => {
  assert.match(formatSqlPreview('select top 1 * from users', { language: 'transactsql' }), /^SELECT\n  TOP 1/);
  assert.equal(formatSqlPreview(''), '');
});

test('text preview classification prefers supported extensions and validates UTF-8 limits', () => {
  assert.equal(filePreviewFormat({ name: 'README.md', mimeType: 'application/octet-stream' }), 'markdown');
  assert.equal(filePreviewFormat({ name: 'query.sql', mimeType: 'text/plain' }), 'sql');
  assert.equal(filePreviewFormat({ name: 'rows.csv', mimeType: 'text/plain' }), 'csv');
  assert.equal(filePreviewFormat({ name: 'notes.txt', mimeType: 'application/octet-stream' }), 'text');
  assert.equal(filePreviewFormat({ name: 'archive.zip', mimeType: 'application/zip' }), 'unsupported');
  assert.equal(decodeUtf8Preview(Buffer.from('\uFEFF你好')), '你好');
  assert.throws(
    () => decodeUtf8Preview(Buffer.from([0xff]), { maxBytes: 2 }),
    (error) => error.code === 'PREVIEW_ENCODING_UNSUPPORTED' && error.status === 415,
  );
  assert.throws(
    () => decodeUtf8Preview(Buffer.from('abc'), { maxBytes: 2 }),
    (error) => error.code === 'PREVIEW_TOO_LARGE' && error.status === 413,
  );
});

test('CSV preview handles quoting, embedded newlines, duplicate headers and bounded rows', async () => {
  const parsed = await parseCsvPreview(Buffer.from(
    '\uFEFFname,name,,note\r\nAlice,A,"","hello, world"\r\nBob,B,,"line 1\nline 2"\r\n',
  ));
  assert.deepEqual(parsed, {
    headers: ['name', 'Column 2', 'Column 3', 'note'],
    rows: [
      ['Alice', 'A', '', 'hello, world'],
      ['Bob', 'B', '', 'line 1\nline 2'],
    ],
    previewedRows: 2,
    hasMore: false,
  });
  const bounded = await parseCsvPreview('id\n1\n2\n3\n', { maxRows: 2 });
  assert.deepEqual(bounded.rows, [['1'], ['2']]);
  assert.equal(bounded.hasMore, true);
  assert.deepEqual(await parseCsvPreview('""'), {
    headers: ['Column 1'], rows: [], previewedRows: 0, hasMore: false,
  });
});

test('CSV preview rejects malformed and excessively wide input without exposing fields', async () => {
  await assert.rejects(
    parseCsvPreview('name\n"not closed'),
    (error) => error.code === 'CSV_PARSE_FAILED' && /record 2/.test(error.message),
  );
  await assert.rejects(
    parseCsvPreview('a,b,c', { maxColumns: 2 }),
    (error) => error.code === 'CSV_TOO_WIDE' && /record 1/.test(error.message),
  );
});

test('SQL syntax tokens distinguish safe text categories without producing markup', () => {
  const tokens = tokenizeSqlPreview("-- note\nselect count(*) from `events` where id = @id and label = '<b>'");
  assert.ok(tokens.some((token) => token.type === 'comment' && token.text === '-- note'));
  assert.ok(tokens.some((token) => token.type === 'keyword' && token.text.toLowerCase() === 'select'));
  assert.ok(tokens.some((token) => token.type === 'function' && token.text.toLowerCase() === 'count'));
  assert.ok(tokens.some((token) => token.type === 'parameter' && token.text === '@id'));
  assert.ok(tokens.some((token) => token.type === 'string' && token.text === "'<b>'"));
  assert.equal(tokens.map((token) => token.text).join(''), "-- note\nselect count(*) from `events` where id = @id and label = '<b>'");
});
