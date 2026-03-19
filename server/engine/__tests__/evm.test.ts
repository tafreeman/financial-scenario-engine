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
} from "../evm.js";

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

  it("returns 0 for zero AC", () => {
    expect(calcCPI(100, 0)).toBe(0);
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

  it("returns 0 for zero CPI", () => {
    expect(calcEACTypical(1000, 0)).toBe(0);
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

  it("returns 0 when BAC = AC", () => {
    expect(calcTCPI(1000, 500, 1000)).toBe(0);
  });
});

describe("calcEarnedValue", () => {
  it("returns percentComplete/100 * BAC", () => {
    expect(calcEarnedValue(50, 1000)).toBe(500);
    expect(calcEarnedValue(0, 1000)).toBe(0);
    expect(calcEarnedValue(100, 1000)).toBe(1000);
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
