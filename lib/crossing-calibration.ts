import crossingCalibration from "../config/crossing-calibration.json";
import {
  createShadowBiasState as createState,
  learnShadowBias as learnBias,
  shadowEffectiveBias as effectiveBiasAt,
  shadowMinutesForSource as minutesForSource,
} from "./shadow-fit.js";

export type CalibrationDirection = keyof typeof crossingCalibration.directions;
export type ShadowBiasState = {
  learnedBias: number;
  lastCheckpointMs: number | null;
};

export function createShadowBiasState(): ShadowBiasState {
  return createState();
}

export function shadowEffectiveBias(state: ShadowBiasState, atMs: number) {
  return effectiveBiasAt(state, atMs, crossingCalibration);
}

export function shadowMinutesForSource(
  gmapsMinutes: number,
  direction: CalibrationDirection,
  effectiveBias: number,
) {
  return minutesForSource(gmapsMinutes, direction, effectiveBias, crossingCalibration);
}

export function learnShadowBias(
  state: ShadowBiasState,
  gmapsMean: number,
  checkpointMid: number | null | undefined,
  direction: CalibrationDirection,
  atMs: number,
  effectiveBias: number,
): ShadowBiasState {
  return learnBias(state, gmapsMean, checkpointMid, direction, atMs, effectiveBias, crossingCalibration);
}

export function clampCrossingMinutes(value: number) {
  return Math.round(Math.max(
    crossingCalibration.minimumMinutes,
    Math.min(crossingCalibration.maximumMinutes, value),
  ));
}

export { crossingCalibration };
