export function createShadowBiasState() {
  return { learnedBias: 0, lastCheckpointMs: null };
}

export function shadowEffectiveBias(state, atMs, config) {
  if (state.lastCheckpointMs == null) return 0;
  const hoursSinceCheckpoint = (atMs - state.lastCheckpointMs) / 3_600_000;
  const decay = hoursSinceCheckpoint <= config.biasHoldHours
    ? 1
    : 0.5 ** ((hoursSinceCheckpoint - config.biasHoldHours) / config.biasHalfLifeHours);
  return state.learnedBias * decay;
}

export function shadowMinutesForSource(gmapsMinutes, direction, effectiveBias, config) {
  const settings = config.directions[direction];
  const value = settings.intercept
    + settings.slope * gmapsMinutes
    + effectiveBias
    + config.displayOffsetMinutes;
  return Math.round(Math.max(config.minimumMinutes, Math.min(config.maximumMinutes, value)));
}

export function learnShadowBias(state, gmapsMean, checkpointMid, direction, atMs, effectiveBias, config) {
  if (!Number.isFinite(checkpointMid) || !Number.isFinite(gmapsMean) || gmapsMean <= 0) return state;
  const settings = config.directions[direction];
  const base = settings.intercept + settings.slope * gmapsMean;
  return {
    learnedBias: settings.alpha * (checkpointMid - base) + (1 - settings.alpha) * effectiveBias,
    lastCheckpointMs: atMs,
  };
}
