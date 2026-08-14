import { format } from 'sql-formatter';

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
