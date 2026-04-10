# Earned Value Management (EVM)

`server/engine/evm.ts` provides a full EVM suite: CPI, SPI, CV, SV, four EAC variants, ETC, VAC, and TCPI.

## Functions

### Individual EVM Calculations

| Function | Description | Formula |
|----------|-------------|---------|
| `calcCPI(ev, ac)` | Cost Performance Index | `EV / AC` |
| `calcSPI(ev, pv)` | Schedule Performance Index | `EV / PV` |
| `calcCV(ev, ac)` | Cost Variance | `EV − AC` |
| `calcSV(ev, pv)` | Schedule Variance | `EV − PV` |
| `calcEACTypical(bac, cpi)` | EAC — variance continues | `BAC / CPI` |
| `calcEACAtypical(ac, bac, ev)` | EAC — one-time variance | `AC + (BAC − EV)` |
| `calcEACMixed(ac, bac, ev, cpi, spi)` | EAC — blended | `AC + (BAC − EV) / (CPI × SPI)` |
| `calcETC(eac, ac)` | Estimate to Complete | `EAC − AC` |
| `calcVAC(bac, eac)` | Variance at Completion | `BAC − EAC` |
| `calcTCPI(bac, ev, ac)` | To-Complete Performance Index | `(BAC − EV) / (BAC − AC)` |

### Derived Values

| Function | Description |
|----------|-------------|
| `calcPlannedValue(project)` | PV from start/end dates and BAC |
| `calcEarnedValue(project)` | EV = BAC × (spent / budget) |

### Complete EVM

### `calcEvm(project)`

Compute all EVM metrics for a project in a single call.

**Input:** `Project`
**Output:** `EvmMetrics`

```typescript
import { calcEvm } from "./engine/index.js";

const evm = calcEvm(project);
// → {
//   bac: 1250000,
//   ac: 450000,
//   pv: 520000,
//   ev: 450000,
//   cpi: 1.0,
//   spi: 0.87,
//   cv: 0,
//   sv: -70000,
//   eac_typical: 1250000,
//   eac_atypical: 1250000,
//   eac_mixed: 1437000,
//   etc: 800000,
//   vac: 0,
//   tcpi: 1.0
// }
```

## EVM Interpretation Guide

| Metric | Good | Warning | Critical |
|--------|------|---------|----------|
| CPI | > 1.0 (under budget) | 0.9–1.0 | < 0.9 |
| SPI | > 1.0 (ahead of schedule) | 0.9–1.0 | < 0.9 |
| CV | > 0 (under budget) | Near 0 | < 0 |
| SV | > 0 (ahead of schedule) | Near 0 | < 0 |
| TCPI | < 1.0 (achievable) | 1.0–1.1 | > 1.1 |
