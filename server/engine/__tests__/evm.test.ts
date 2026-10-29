import { describe, it, expect } from "vitest";
import {
  calcCPI,
  calcSPI,
  calcCV,
  calcSV,
  calcEACTypical,
  calcEACAtypical,
  calcEACMixed,
  calcETC,
  calcVAC,
  calcTCPI,
  calcEarnedValue,
  calcEvm,
  calcPlannedValue,
} from "../evm.js";
import type { Project } from "../types.js";

describe("calcCPI", () => {
  it("returns EV / AC", () => {
    expect(calcCPI(100, 110)).toBeCloseTo(100 / 110, 5);
  });

  it("CPI > 1 means under budget", () => {
    expect(calcCPI(110, 100)).toBeGreaterThan(1);
  });

  it("CPI < 1 means over budget", () => {
    expect(calcCPI(90, 100)).toBeLessThan(1);
  });
});

describe("calcSPI", () => {
  it("returns EV / PV", () => {
    expect(calcSPI(100, 120)).toBeCloseTo(100 / 120, 5);
  });

  it("SPI > 1 means ahead of schedule", () => {
    expect(calcSPI(120, 100)).toBeGreaterThan(1);
  });
});

describe("calcCV", () => {
  it("returns EV - AC (positive = under budget)", () => {
    expect(calcCV(110, 100)).toBe(10);
  });
});

describe("calcSV", () => {
  it("returns EV - PV (positive = ahead)", () => {
    expect(calcSV(110, 100)).toBe(10);
  });
});

describe("calcEACTypical", () => {
  it("returns BAC / CPI", () => {
    const cpi = 100 / 110; // ~0.909
    expect(calcEACTypical(1000, cpi)).toBeCloseTo(1000 / cpi, 2);
  });

  it("is not computable (null) unless CPI is a finite number > 0", () => {
    expect(calcEACTypical(1000, 0)).toBeNull();
    expect(calcEACTypical(1000, null)).toBeNull();
    expect(calcEACTypical(1000, -1)).toBeNull();
    expect(calcEACTypical(1000, Number.NaN)).toBeNull();
  });
});

describe("calcEACAtypical", () => {
  it("returns AC + (BAC - EV)", () => {
    expect(calcEACAtypical(110, 1000, 100)).toBe(110 + (1000 - 100));
  });
});

describe("calcEACMixed", () => {
  it("returns AC + (BAC-EV)/(CPI*SPI)", () => {
    const cpi = 0.9;
    const spi = 0.8;
    expect(calcEACMixed(110, 1000, 100, cpi, spi)).toBeCloseTo(110 + (900) / (cpi * spi), 2);
  });
});

describe("calcETC", () => {
  it("returns EAC - AC", () => {
    expect(calcETC(1100, 500)).toBe(600);
  });
});

describe("calcVAC", () => {
  it("returns BAC - EAC (positive = under budget at end)", () => {
    expect(calcVAC(1000, 1100)).toBe(-100);
    expect(calcVAC(1000, 900)).toBe(100);
  });
});

describe("calcTCPI", () => {
  it("returns (BAC-EV)/(BAC-AC)", () => {
    expect(calcTCPI(1000, 500, 600)).toBeCloseTo((1000 - 500) / (1000 - 600), 5);
  });

  it("is null (not computable) when BAC = AC", () => {
    expect(calcTCPI(1000, 500, 1000)).toBeNull();
  });
});

describe("calcEarnedValue", () => {
  it("returns percentComplete/100 * BAC", () => {
    expect(calcEarnedValue(50, 1000)).toBe(500);
    expect(calcEarnedValue(0, 1000)).toBe(0);
    expect(calcEarnedValue(100, 1000)).toBe(1000);
  });
});

describe("calcPlannedValue", () => {
  const project: Project = {
    id: 1,
    name: "Linear Project",
    total_budget: 1000,
    spent_to_date: 0,
    start_date: "2025-01-01",
    end_date: "2025-12-31",
    status: "active",
  };

  it("returns half the budget at the schedule midpoint", () => {
    // ~halfway through the Jan 1 -> Dec 31 window.
    const midpoint = new Date("2025-07-02");
    const pv = calcPlannedValue(project, midpoint);
    // Should be close to 50% of the budget; allow a small slack for the
    // exact day count (a few days off midpoint).
    expect(pv).toBeGreaterThan(project.total_budget * 0.45);
    expect(pv).toBeLessThan(project.total_budget * 0.55);
  });

  it("clamps to 0 before the project start (fraction floored at 0)", () => {
    const beforeStart = new Date("2024-06-01");
    expect(calcPlannedValue(project, beforeStart)).toBe(0);
  });

  it("clamps to full budget after the project end (fraction capped at 1)", () => {
    const afterEnd = new Date("2026-06-01");
    expect(calcPlannedValue(project, afterEnd)).toBe(project.total_budget);
  });

  it("returns the full budget when duration is non-positive (end <= start)", () => {
    const zeroDuration: Project = {
      ...project,
      start_date: "2025-06-01",
      end_date: "2025-06-01",
    };
    expect(calcPlannedValue(zeroDuration, new Date("2025-06-15"))).toBe(
      zeroDuration.total_budget
    );
  });

  it("defaults asOfDate to now when omitted", () => {
    // With no asOfDate, the function uses new Date(); the result must stay
    // within the valid [0, budget] envelope regardless of the current date.
    const pv = calcPlannedValue(project);
    expect(pv).toBeGreaterThanOrEqual(0);
    expect(pv).toBeLessThanOrEqual(project.total_budget);
  });
});

describe("calcCPI / calcSPI zero denominators", () => {
  it("returns null, not 0, when AC = 0 or PV = 0", () => {
    expect(calcCPI(0, 0)).toBeNull();
    expect(calcCPI(100, 0)).toBeNull();
    expect(calcSPI(0, 0)).toBeNull();
    expect(calcSPI(100, 0)).toBeNull();
  });

  it("keeps a genuine 0 when the denominator is positive and EV = 0", () => {
    expect(calcCPI(0, 100)).toBe(0);
    expect(calcSPI(0, 100)).toBe(0);
  });
});

describe("calcEACMixed with unusable indices", () => {
  it("is null when CPI or SPI is null, or their product is not > 0", () => {
    expect(calcEACMixed(100, 1000, 0, null, 1)).toBeNull();
    expect(calcEACMixed(100, 1000, 0, 1, null)).toBeNull();
    expect(calcEACMixed(100, 1000, 0, 0, 1)).toBeNull();
  });
});

describe("calcEvm zero-denominator semantics", () => {
  const BAC = 1000;
  const PV = 500;

  function expectFallbackEac(r: ReturnType<typeof calcEvm>): void {
    const atypical = r.ac + (r.bac - r.ev);
    expect(r.eac_atypical).toBe(atypical);
    expect(r.eac_typical).toBe(atypical);
    expect(r.eac_mixed).toBe(atypical);
    expect(r.etc).toBe(r.eac_typical - r.ac);
    expect(r.vac).toBe(r.bac - r.eac_typical);
  }

  it("(a) AC = 0 and EV = 0: CPI null, EAC falls back, ETC never negative", () => {
    const r = calcEvm(BAC, 0, PV, 0);
    expect(r.cpi).toBeNull();
    expect(r.spi).toBe(0); // PV > 0 and EV = 0 is a genuine 0
    expectFallbackEac(r);
    expect(r.eac_typical).not.toBe(0);
    expect(r.etc).toBeGreaterThanOrEqual(0);
    expect(r.vac).toBe(r.bac - r.eac_typical);
  });

  it("(b) AC > 0 and EV = 0: CPI is a real 0, EAC falls back, ETC never negative", () => {
    const AC = 100;
    const r = calcEvm(BAC, AC, PV, 0);
    expect(r.cpi).toBe(0);
    expectFallbackEac(r);
    expect(r.eac_typical).not.toBe(0);
    expect(r.etc).toBeGreaterThanOrEqual(0);
    expect(r.vac).toBe(r.bac - r.eac_typical);
  });

  it("(c) AC = 0 and EV > 0: CPI null, EAC falls back to atypical", () => {
    const EV = 200;
    const r = calcEvm(BAC, 0, PV, EV);
    expect(r.cpi).toBeNull();
    expect(r.spi).toBeCloseTo(EV / PV, 10);
    expectFallbackEac(r);
    expect(r.eac_typical).toBe(BAC - EV);
    expect(r.etc).toBeGreaterThanOrEqual(0);
  });

  it("PV = 0: SPI null while CPI stays computable and EAC(typical) uses it", () => {
    const AC = 100;
    const EV = 80;
    const r = calcEvm(BAC, AC, 0, EV);
    expect(r.spi).toBeNull();
    expect(r.cpi).toBeCloseTo(EV / AC, 10);
    expect(r.eac_typical).toBeCloseTo(BAC / (EV / AC), 6);
    // Mixed needs SPI, so it falls back to atypical.
    expect(r.eac_mixed).toBe(r.eac_atypical);
  });

  it("TCPI is null when BAC = AC", () => {
    expect(calcEvm(BAC, BAC, PV, 400).tcpi).toBeNull();
  });

  it("uses the typical estimate when CPI is a usable positive number", () => {
    const r = calcEvm(BAC, 500, PV, 480);
    expect(r.eac_typical).toBeCloseTo(BAC / (480 / 500), 6);
    expect(r.etc).toBe(r.eac_typical - r.ac);
    expect(r.vac).toBe(BAC - r.eac_typical);
  });
});

describe("calcEvm", () => {
  it("assembles all EVM metrics from core inputs", () => {
    const result = calcEvm(1000, 500, 600, 480);

    expect(result.bac).toBe(1000);
    expect(result.ac).toBe(500);
    expect(result.pv).toBe(600);
    expect(result.ev).toBe(480);
    expect(result.cpi).toBeCloseTo(480 / 500, 5);
    expect(result.spi).toBeCloseTo(480 / 600, 5);
    expect(result.cv).toBe(-20);
    expect(result.sv).toBe(-120);
  });
});
