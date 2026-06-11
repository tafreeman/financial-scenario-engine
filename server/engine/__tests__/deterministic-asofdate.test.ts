/**
 * Tests for Fix #19 — deterministic asOfDate parameter.
 *
 * calcTimelineExtensionImpact and calcPlannedValue (used in EVM analysis) both
 * called new Date() internally, making budget_gap, new_total_projected, pv,
 * cpi, spi, eac_*, and tcpi vary with wall-clock time for identical inputs.
 *
 * Done-when: executeScenario with the same operation, snapshot, and pinned
 * asOfDate at T and T+24h produces identical budget_gap, new_total_projected,
 * pv, cpi, spi, eac_*.
 *
 * Strategy: run the same scenario twice with two different pinned dates that are
 * separated by 24 hours.  Without the fix these would differ; with the fix they
 * differ correctly (each reflects its own date) AND — crucially — the same pinned
 * date always produces the same result (determinism guarantee).
 */

import { describe, it, expect } from "vitest";
import {
  calcTimelineExtensionImpact,
  calcScenarioImpact,
} from "../scenarios.js";
import { calcPlannedValue } from "../evm.js";
import { executeScenario } from "../executor.js";
import type { ProjectSnapshot, PortfolioSnapshot, StaffingRecord, LaborCategory, Project } from "../types.js";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const labor_categories: LaborCategory[] = [
  { id: 1, name: "Lead Architect",     bill_rate: 285, cost_rate: 210 },
  { id: 2, name: "Senior Developer",   bill_rate: 245, cost_rate: 185 },
  { id: 3, name: "Mid-level Developer", bill_rate: 185, cost_rate: 135 },
];

const alphaStaffing: StaffingRecord[] = [
  {
    id: 1, project_id: 1, project_name: "Project Alpha",
    labor_category_id: 2, labor_category: "Senior Developer",
    person_name: "J. Smith", hours_per_week: 40,
    bill_rate: 245, cost_rate: 185, is_active: 1,
  },
  {
    id: 2, project_id: 1, project_name: "Project Alpha",
    labor_category_id: 3, labor_category: "Mid-level Developer",
    person_name: "K. Chen", hours_per_week: 40,
    bill_rate: 185, cost_rate: 135, is_active: 1,
  },
];

const alphaProject: Project = {
  id: 1, name: "Project Alpha",
  total_budget: 1_250_000, spent_to_date: 485_000,
  start_date: "2025-10-01", end_date: "2026-09-30",
  status: "active",
};

const alphaSnapshot: ProjectSnapshot = { ...alphaProject, staffing: alphaStaffing };

const portfolio: PortfolioSnapshot = {
  projects: [alphaSnapshot],
  labor_categories,
};

// Two reference dates separated by 24 hours
const DATE_T0 = new Date("2026-04-15T12:00:00.000Z");
const DATE_T24 = new Date("2026-04-16T12:00:00.000Z");

// ─── calcTimelineExtensionImpact determinism ─────────────────────────────────

describe("calcTimelineExtensionImpact — asOfDate parameter", () => {
  const monthlyBurn = 100_000;

  it("produces identical outputs for the same pinned asOfDate called twice", () => {
    const r1 = calcTimelineExtensionImpact(alphaSnapshot, monthlyBurn, 6, undefined, DATE_T0);
    const r2 = calcTimelineExtensionImpact(alphaSnapshot, monthlyBurn, 6, undefined, DATE_T0);
    expect(r1).toEqual(r2);
  });

  it("produces different new_total_projected and budget_gap for T0 vs T+24h", () => {
    const r0 = calcTimelineExtensionImpact(alphaSnapshot, monthlyBurn, 6, undefined, DATE_T0);
    const r24 = calcTimelineExtensionImpact(alphaSnapshot, monthlyBurn, 6, undefined, DATE_T24);

    // new_end_date is the same regardless of asOfDate
    expect(r0.new_end_date).toBe(r24.new_end_date);
    expect(r0.additional_months).toBeCloseTo(r24.additional_months, 5);
    expect(r0.additional_cost).toBeCloseTo(r24.additional_cost, 5);

    // new_total_projected and budget_gap depend on remainingMonthsNew = (newEnd - now),
    // so they differ by ~1 day's worth of burn between T0 and T+24h.
    // We assert they differ rather than being equal (proves the date is being used).
    expect(r0.new_total_projected).not.toBe(r24.new_total_projected);
    expect(r0.budget_gap).not.toBe(r24.budget_gap);
  });

  it("no-op result is fully deterministic (does not call new Date() at all)", () => {
    const r1 = calcTimelineExtensionImpact(alphaSnapshot, monthlyBurn);
    const r2 = calcTimelineExtensionImpact(alphaSnapshot, monthlyBurn);
    expect(r1).toEqual(r2);
    expect(r1.additional_months).toBe(0);
    expect(r1.budget_gap).toBe(0);
  });
});

// ─── calcPlannedValue determinism ─────────────────────────────────────────────

describe("calcPlannedValue — asOfDate parameter (existing API, not changed)", () => {
  it("produces identical outputs for the same pinned asOfDate called twice", () => {
    const pv1 = calcPlannedValue(alphaProject, DATE_T0);
    const pv2 = calcPlannedValue(alphaProject, DATE_T0);
    expect(pv1).toBe(pv2);
  });

  it("produces a different PV for T0 vs T+24h (one day closer to end → higher PV)", () => {
    const pv0 = calcPlannedValue(alphaProject, DATE_T0);
    const pv24 = calcPlannedValue(alphaProject, DATE_T24);
    // T+24h is further along the timeline → higher planned value
    expect(pv24).toBeGreaterThan(pv0);
    // The difference is ~1/365 of total_budget, within a small tolerance
    const oneDayFraction = 1 / (365.25);
    expect(pv24 - pv0).toBeCloseTo(alphaProject.total_budget * oneDayFraction, -2);
  });
});

// ─── executeScenario — timeline_extension determinism ────────────────────────

describe("executeScenario — timeline_extension with pinned asOfDate", () => {
  it("produces identical results when called twice with the same pinned date", () => {
    const op = {
      action: "timeline_extension" as const,
      project: "Project Alpha",
      extension_months: 6,
    };

    const r1 = executeScenario(op, portfolio, DATE_T0);
    const r2 = executeScenario(op, portfolio, DATE_T0);

    // Full deep equality — every field must be identical for the same pinned date
    expect(r1.projected?.budget).toEqual(r2.projected?.budget);
    expect(r1.impact).toEqual(r2.impact);
    expect(r1.warnings).toEqual(r2.warnings);
  });

  it("calcTimelineExtensionImpact outputs (budget_gap, new_total_projected) differ between T0 and T+24h", () => {
    // The wall-clock-sensitive fields live in calcTimelineExtensionImpact's output,
    // not in the ScenarioResult envelope (which only surfaces the warning).
    // We verify the fix at the function level for these two specific fields.
    const monthlyBurn = 100_000;
    const r0 = calcTimelineExtensionImpact(alphaSnapshot, monthlyBurn, 6, undefined, DATE_T0);
    const r24 = calcTimelineExtensionImpact(alphaSnapshot, monthlyBurn, 6, undefined, DATE_T24);

    // new_total_projected and budget_gap are the financially-material outputs
    // that were previously non-deterministic.
    expect(r0.new_total_projected).not.toBeCloseTo(r24.new_total_projected, 2);
    expect(r0.budget_gap).not.toBeCloseTo(r24.budget_gap, 2);
    // The new end date itself is deterministic (depends only on extension_months)
    expect(r0.new_end_date).toBe(r24.new_end_date);
  });
});

// ─── executeScenario — evm_analysis with pinned asOfDate ─────────────────────

describe("executeScenario — evm_analysis with pinned asOfDate", () => {
  it("produces identical EVM metrics when called twice with the same pinned date", () => {
    const op = {
      action: "evm_analysis" as const,
      project: "Project Alpha",
    };

    const r1 = executeScenario(op, portfolio, DATE_T0);
    const r2 = executeScenario(op, portfolio, DATE_T0);

    expect(r1.evm).toBeDefined();
    expect(r2.evm).toBeDefined();
    expect(r1.evm).toEqual(r2.evm);
  });

  it("pv and spi differ between T0 and T+24h (pv is wall-clock-sensitive)", () => {
    const op = {
      action: "evm_analysis" as const,
      project: "Project Alpha",
    };

    const r0 = executeScenario(op, portfolio, DATE_T0);
    const r24 = executeScenario(op, portfolio, DATE_T24);

    expect(r0.evm).toBeDefined();
    expect(r24.evm).toBeDefined();

    // PV (planned value) increases as asOfDate advances through the project timeline.
    // T+24h is one day further along → higher PV.
    expect(r24.evm!.pv).toBeGreaterThan(r0.evm!.pv);

    // SPI = ev / pv; since ev is fixed (spend-ratio proxy, does not depend on date)
    // but pv changes, SPI must differ.
    expect(r0.evm!.spi).not.toBe(r24.evm!.spi);

    // sv (schedule variance = ev - pv) also changes with pv
    expect(r0.evm!.sv).not.toBe(r24.evm!.sv);

    // Note: eac_typical = bac / cpi; when the spend-ratio proxy is used, cpi = ev/ac = 1
    // (because ev = ac under the proxy), so eac_typical = bac regardless of date.
    // We do not assert eac_typical differs — it is correct for it to be constant
    // under the proxy. The wall-clock sensitivity lives entirely in pv/spi/sv.
  });
});
