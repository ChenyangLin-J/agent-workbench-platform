const ACCESS_MODE_LABELS = Object.freeze({
  full: '完全访问',
  restricted: '受限访问',
});

export function publicRuntimeModels(models = []) {
  return (Array.isArray(models) ? models : [])
    .filter((model) => !model?.hidden)
    .map((model) => ({
      id: String(model?.id || model?.model || ''),
      model: String(model?.model || model?.id || ''),
      displayName: String(model?.displayName || model?.model || model?.id || ''),
      description: String(model?.description || ''),
      isDefault: Boolean(model?.isDefault),
      defaultReasoningEffort: String(model?.defaultReasoningEffort || 'medium'),
      supportedReasoningEfforts: (Array.isArray(model?.supportedReasoningEfforts)
        ? model.supportedReasoningEfforts
        : []).map((effort) => ({
          reasoningEffort: String(effort?.reasoningEffort || effort || ''),
          description: String(effort?.description || ''),
        })).filter((effort) => effort.reasoningEffort),
      serviceTiers: (Array.isArray(model?.serviceTiers) ? model.serviceTiers : []).map((tier) => ({
        id: String(tier?.id || tier || ''),
        name: String(tier?.name || tier?.id || tier || ''),
        description: String(tier?.description || ''),
      })).filter((tier) => tier.id),
      defaultServiceTier: model?.defaultServiceTier == null ? null : String(model.defaultServiceTier),
    }))
    .filter((model) => model.id && model.model);
}

export function executionAccessModes(manifest) {
  const configured = Array.isArray(manifest?.runtime?.accessModes) && manifest.runtime.accessModes.length
    ? manifest.runtime.accessModes
    : [defaultAccessMode(manifest)];
  return [...new Set(configured.map(String))]
    .filter((mode) => mode in ACCESS_MODE_LABELS)
    .map((id) => ({ id, label: ACCESS_MODE_LABELS[id] }));
}

export function defaultExecutionProfile(manifest, models = []) {
  const model = selectModel(models, manifest?.runtime?.model)
    || models.find((candidate) => candidate.isDefault)
    || models[0]
    || null;
  const accessModes = executionAccessModes(manifest);
  return {
    model: String(model?.model || manifest?.runtime?.model || ''),
    reasoningEffort: String(
      manifest?.runtime?.reasoningEffort
      || model?.defaultReasoningEffort
      || model?.supportedReasoningEfforts?.[0]?.reasoningEffort
      || 'medium',
    ),
    accessMode: accessModes[0]?.id || defaultAccessMode(manifest),
    serviceTier: null,
  };
}

export function storedExecutionProfile(value, fallback) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ...fallback };
  return {
    model: typeof value.model === 'string' && value.model.trim() ? value.model : fallback.model,
    reasoningEffort: typeof value.reasoningEffort === 'string' && value.reasoningEffort.trim()
      ? value.reasoningEffort
      : fallback.reasoningEffort,
    accessMode: ['full', 'restricted'].includes(value.accessMode)
      ? value.accessMode
      : fallback.accessMode,
    serviceTier: value.serviceTier == null ? null : String(value.serviceTier),
  };
}

export function validateExecutionProfile(value, { manifest, models, fallback }) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw executionProfileError('HOST_EXECUTION_PROFILE_INVALID', '执行设置无效。', 400);
  }
  if (!models.length) {
    throw executionProfileError('HOST_MODEL_CATALOG_UNAVAILABLE', '模型目录暂时不可用，无法修改执行设置。', 503);
  }
  const model = selectModel(models, value.model ?? fallback.model);
  if (!model) throw executionProfileError('HOST_MODEL_UNAVAILABLE', '所选模型当前不可用。', 400);
  const reasoningEffort = String(value.reasoningEffort ?? fallback.reasoningEffort ?? '').trim();
  const efforts = new Set(model.supportedReasoningEfforts.map((effort) => effort.reasoningEffort));
  if (!reasoningEffort || (efforts.size && !efforts.has(reasoningEffort))) {
    throw executionProfileError('HOST_REASONING_EFFORT_UNAVAILABLE', '所选模型不支持这个思考强度。', 400);
  }
  const accessMode = String(value.accessMode ?? fallback.accessMode ?? '');
  if (!executionAccessModes(manifest).some((mode) => mode.id === accessMode)) {
    throw executionProfileError('HOST_ACCESS_MODE_FORBIDDEN', '当前 Environment 不允许所选权限模式。', 403);
  }
  const serviceTier = value.serviceTier == null ? null : String(value.serviceTier);
  if (serviceTier && !model.serviceTiers.some((tier) => tier.id === serviceTier)) {
    throw executionProfileError('HOST_SERVICE_TIER_UNAVAILABLE', '所选模型当前不支持 Fast 模式。', 400);
  }
  return {
    model: model.model,
    reasoningEffort,
    accessMode,
    serviceTier,
  };
}

export function runtimeExecutionSettings(profile) {
  return {
    model: profile.model,
    reasoningEffort: profile.reasoningEffort,
    sandbox: profile.accessMode === 'full' ? 'danger-full-access' : 'workspace-write',
    approvalPolicy: profile.accessMode === 'full' ? 'never' : 'on-request',
    serviceTier: profile.serviceTier ?? null,
  };
}

function selectModel(models, value) {
  const requested = String(value || '').trim();
  return requested
    ? models.find((model) => model.model === requested || model.id === requested) || null
    : null;
}

function defaultAccessMode(manifest) {
  return manifest?.isolation?.effectiveLevel === 'ephemeral-machine'
    && ['no-external-effects', 'read-only-data-adapter-allowlist']
      .includes(manifest?.isolation?.enforcement?.externalEffects?.mode)
    ? 'full'
    : 'restricted';
}

function executionProfileError(code, message, status) {
  return Object.assign(new Error(message), { code, status });
}
