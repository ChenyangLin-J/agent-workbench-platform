export async function configureCodexSkillRoots(connection, {
  extraRoots = [],
  cwds = [],
  expectedSkills = [],
  forceReload = true,
} = {}) {
  if (!connection?.request) throw new TypeError('Codex Skill configuration requires an App Server connection.');
  const roots = uniqueStrings(extraRoots);
  const workingDirectories = uniqueStrings(cwds);
  const expected = uniqueStrings(expectedSkills);
  await connection.request('skills/extraRoots/set', { extraRoots: roots });
  const result = await connection.request('skills/list', { cwds: workingDirectories, forceReload: Boolean(forceReload) });
  const skills = (result?.data ?? []).flatMap((entry) => entry?.skills ?? []).filter((skill) => skill?.enabled !== false);
  const names = new Set(skills.map((skill) => String(skill.name || '')).filter(Boolean));
  const missing = expected.filter((name) => !names.has(name));
  return Object.freeze({
    ready: missing.length === 0,
    roots: Object.freeze(roots),
    skills: Object.freeze(skills.map((skill) => Object.freeze({
      name: String(skill.name || ''),
      path: String(skill.path || ''),
    }))),
    expected: Object.freeze(expected),
    missing: Object.freeze(missing),
  });
}

export function createCodexConnectionPreparation(prepare) {
  if (typeof prepare !== 'function') throw new TypeError('Codex connection preparation must be a function.');
  const states = new WeakMap();
  return async function prepareConnection(connection) {
    const current = states.get(connection);
    if (current?.ready) return current.value;
    if (current?.promise) return current.promise;
    const state = {};
    state.promise = Promise.resolve().then(() => prepare(connection)).then((value) => {
      state.ready = true;
      state.value = value;
      state.promise = null;
      return value;
    }).catch((error) => {
      states.delete(connection);
      throw error;
    });
    states.set(connection, state);
    return state.promise;
  };
}

function uniqueStrings(value) {
  if (!Array.isArray(value)) throw new TypeError('Codex Skill configuration lists must be arrays.');
  return [...new Set(value.map((item) => String(item || '').trim()).filter(Boolean))];
}
