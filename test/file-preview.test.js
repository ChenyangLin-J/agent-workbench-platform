import assert from 'node:assert/strict';
import test from 'node:test';
import { formatSqlPreview } from '../src/file-preview.js';

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
