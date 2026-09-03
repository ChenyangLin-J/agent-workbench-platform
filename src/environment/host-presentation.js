export function selectMinimalHostSession(sessions = [], selectedId = null) {
  const ids = sessions.map(sessionIdentifier).filter(Boolean);
  const current = selectedId == null ? null : String(selectedId);
  return current && ids.includes(current) ? current : ids[0] || null;
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

function sessionIdentifier(session) {
  const value = session?.sessionId || session?.id;
  return value == null ? null : String(value);
}
