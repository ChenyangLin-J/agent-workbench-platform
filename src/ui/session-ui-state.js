/** Session-local reading and input state, independent of a Host's transport. */
export function createSessionUiStateStore(storage = null, key = 'agent-workbench.session-ui-state') {
  let entries = [];
  try { entries = JSON.parse(storage?.getItem(key) || '[]'); } catch { /* Private browsing and corrupt cache are recoverable. */ }
  const store = new Map(Array.isArray(entries) ? entries.filter(value => Array.isArray(value) && typeof value[0] === 'string' && value[1] && typeof value[1] === 'object').slice(-50) : []);
  const set = store.set.bind(store);
  store.set = (id, value) => {
    set(id, value);
    if (store.size > 50) store.delete(store.keys().next().value);
    try {
      storage?.setItem(key, JSON.stringify([...store].map(([sessionId, state]) => [sessionId, {
        ...state,
        attachments: (state.attachments || []).filter(attachment => attachment.status !== 'uploading' && (attachment.path || attachment.resourceId)),
      }])));
    } catch { /* Keep in-memory recovery when storage is unavailable. */ }
    return store;
  };
  return store;
}
