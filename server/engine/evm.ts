import {
  safeDivide,
  type Project,
  type EvmMetrics,
} from "./types.js";

// ─── Core EVM Indices ────────────────────────────────────────────────────────

/** Cost Performance Index: EV / AC — >1 = under budget */
export function calcCPI(ev: number, ac: number): number {
  return safeDivide(ev, ac);
}

/** Schedule Performance Index: EV / PV — >1 = ahead of schedule */
export function calcSPI(ev: number, pv: number): number {
  return safeDivide(ev, pv);
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

/** EAC Typical: BAC / CPI — variance will continue at same rate */
export function calcEACTypical(bac: number, cpi: number): number {
  return safeDivide(bac, cpi);
}

/** EAC Atypical: AC + (BAC - EV) — variance was one-time, future at plan */
export function calcEACAtypical(ac: number, bac: number, ev: number): number {
  return ac + (bac - ev);
}

/** EAC Mixed: AC + (BAC - EV) / (CPI × SPI) — both cost and schedule variances persist */
export function calcEACMixed(ac: number, bac: number, ev: number, cpi: number, spi: number): number {
  return ac + safeDivide(bac - ev, cpi * spi);
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

/** To-Complete Performance Index: (BAC - EV) / (BAC - AC) — CPI needed to finish on budget */
export function calcTCPI(bac: number, ev: number, ac: number): number {
  return safeDivide(bac - ev, bac - ac);
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
  const eac_typical = calcEACTypical(bac, cpi);
  const eac_atypical = calcEACAtypical(ac, bac, ev);
  const eac_mixed = calcEACMixed(ac, bac, ev, cpi, spi);
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
