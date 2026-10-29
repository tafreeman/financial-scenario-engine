import {
  type Project,
  type EvmMetrics,
} from "./types.js";

// ─── Core EVM Indices ────────────────────────────────────────────────────────

/**
 * Ratio that is `null` when it is not computable (zero or non-finite
 * denominator). Unlike safeDivide, it never substitutes 0: a zero
 * denominator is "no data", which must not read as a real index of 0.
 */
function ratioOrNull(numerator: number, denominator: number): number | null {
  if (denominator === 0 || !Number.isFinite(denominator)) return null;
  const result = numerator / denominator;
  return Number.isFinite(result) ? result : null;
}

/** Cost Performance Index: EV / AC — >1 = under budget; null when AC = 0 */
export function calcCPI(ev: number, ac: number): number | null {
  return ratioOrNull(ev, ac);
}

/** Schedule Performance Index: EV / PV — >1 = ahead of schedule; null when PV = 0 */
export function calcSPI(ev: number, pv: number): number | null {
  return ratioOrNull(ev, pv);
}

// ─── Variances ───────────────────────────────────────────────────────────────

/** Cost Variance: EV - AC (positive = under budget) */
export function calcCV(ev: number, ac: number): number {
  return ev - ac;
}

/** Schedule Variance: EV - PV (positive = ahead of schedule) */
export function calcSV(ev: number, pv: number): number {
  return ev - pv;
}

// ─── Estimate at Completion (4 variants) ─────────────────────────────────────

/**
 * EAC Typical: BAC / CPI — variance will continue at same rate.
 * null unless CPI is a finite number > 0 (caller falls back to atypical).
 */
export function calcEACTypical(bac: number, cpi: number | null): number | null {
  if (cpi === null || !Number.isFinite(cpi) || cpi <= 0) return null;
  return bac / cpi;
}

/** EAC Atypical: AC + (BAC - EV) — variance was one-time, future at plan */
export function calcEACAtypical(ac: number, bac: number, ev: number): number {
  return ac + (bac - ev);
}

/**
 * EAC Mixed: AC + (BAC - EV) / (CPI × SPI) — both cost and schedule variances persist.
 * null unless CPI × SPI is a finite number > 0 (caller falls back to atypical).
 */
export function calcEACMixed(
  ac: number,
  bac: number,
  ev: number,
  cpi: number | null,
  spi: number | null
): number | null {
  if (cpi === null || spi === null) return null;
  const product = cpi * spi;
  if (!Number.isFinite(product) || product <= 0) return null;
  return ac + (bac - ev) / product;
}

// ─── Remaining Estimates ─────────────────────────────────────────────────────

/** Estimate to Complete: EAC - AC */
export function calcETC(eac: number, ac: number): number {
  return eac - ac;
}

/** Variance at Completion: BAC - EAC (positive = under budget at end) */
export function calcVAC(bac: number, eac: number): number {
  return bac - eac;
}

/** To-Complete Performance Index: (BAC - EV) / (BAC - AC) — CPI needed to finish on budget; null when BAC = AC */
export function calcTCPI(bac: number, ev: number, ac: number): number | null {
  return ratioOrNull(bac - ev, bac - ac);
}

// ─── Value Estimation from Project Data ──────────────────────────────────────

/** Estimate Planned Value based on linear timeline distribution */
export function calcPlannedValue(project: Project, asOfDate?: Date): number {
  const now = asOfDate ?? new Date();
  const start = new Date(project.start_date);
  const end = new Date(project.end_date);

  const totalDuration = end.getTime() - start.getTime();
  if (totalDuration <= 0) return project.total_budget;

  const elapsed = now.getTime() - start.getTime();
  const fractionScheduled = Math.max(0, Math.min(1, elapsed / totalDuration));

  return project.total_budget * fractionScheduled;
}

/** Earned Value: percent_complete × BAC */
export function calcEarnedValue(percentComplete: number, bac: number): number {
  return (percentComplete / 100) * bac;
}

// ─── Full EVM Analysis ───────────────────────────────────────────────────────

/** Assemble complete EVM metrics from core inputs */
export function calcEvm(
  bac: number,
  ac: number,
  pv: number,
  ev: number
): EvmMetrics {
  const cpi = calcCPI(ev, ac);
  const spi = calcSPI(ev, pv);
  const eac_atypical = calcEACAtypical(ac, bac, ev);
  // Typical/mixed need a usable CPI (and SPI); otherwise report the atypical
  // estimate rather than a bogus 0 derived from a zero denominator.
  const eac_typical = calcEACTypical(bac, cpi) ?? eac_atypical;
  const eac_mixed = calcEACMixed(ac, bac, ev, cpi, spi) ?? eac_atypical;
  const etc = calcETC(eac_typical, ac);
  const vac = calcVAC(bac, eac_typical);
  const tcpi = calcTCPI(bac, ev, ac);

  return {
    bac,
    ac,
    pv,
    ev,
    cpi,
    spi,
    cv: calcCV(ev, ac),
    sv: calcSV(ev, pv),
    eac_typical,
    eac_atypical,
    eac_mixed,
    etc,
    vac,
    tcpi,
  };
}
