import crossingCalibration from "../config/crossing-calibration.json";

export type CalibrationDirection = keyof typeof crossingCalibration.directions;

export function clampCrossingMinutes(value: number) {
  return Math.round(Math.max(
    crossingCalibration.minimumMinutes,
    Math.min(crossingCalibration.maximumMinutes, value),
  ));
}

function finitePositive(values: Array<number | null | undefined>) {
  return values.filter((value): value is number => Number.isFinite(value) && (value as number) > 0);
}

/**
 * Checkpoint.sg is the accepted crossing-time truth.
 * GMaps (or a later source such as Mapbox) only ranks approaches around that level.
 * When Checkpoint is missing, fall back to the static intercept/slope fit.
 */
export function adjustSourceMinutesToCheckpoint(
  sourceMinutes: Array<number | null | undefined>,
  checkpointMid: number | null | undefined,
  direction: CalibrationDirection,
): Array<number | null> {
  const settings = crossingCalibration.directions[direction];
  const observed = finitePositive(sourceMinutes);
  const mean = observed.length ? observed.reduce((sum, value) => sum + value, 0) / observed.length : null;
  const pinToCheckpoint = Number.isFinite(checkpointMid) && Number.isFinite(mean);

  return sourceMinutes.map((value) => {
    if (!Number.isFinite(value) || (value as number) <= 0) return null;
    const minutes = value as number;
    if (pinToCheckpoint) {
      return clampCrossingMinutes((checkpointMid as number) + (minutes - (mean as number)));
    }
    return clampCrossingMinutes(
      settings.intercept
        + settings.slope * minutes
        + settings.fallbackBiasMinutes
        + crossingCalibration.displayOffsetMinutes,
    );
  });
}

export { crossingCalibration };
