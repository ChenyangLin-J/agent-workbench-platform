export function selectMinimalHostSession(
  sessions = [],
  selectedId = null,
  { fallback = 'newest' } = {},
) {
  const ids = sessions.map(sessionIdentifier).filter(Boolean);
  const current = selectedId == null ? null : String(selectedId);
  if (current && ids.includes(current)) return current;
  return fallback === 'none' ? null : ids[0] || null;
}

export function minimalHostSessionPresentation(session = {}) {
  return {
    ...session,
    title: session.title === 'New Session' ? '新对话' : session.title,
    contextLabel: session.contextId && !['environment', 'owned'].includes(session.contextId)
      ? session.contextLabel
      : '',
  };
}

export function shouldAutoCreateMinimalHostSession({
  creationAttempted = false,
  initialSessionId = null,
  selectedId = null,
  sessions = [],
  sessionsLoaded = false,
  startsWithNewSession = false,
} = {}) {
  return startsWithNewSession
    && !initialSessionId
    && sessionsLoaded
    && sessions.length === 0
    && !selectedId
    && !creationAttempted;
}

function sessionIdentifier(session) {
  const value = session?.sessionId || session?.id;
  return value == null ? null : String(value);
}
