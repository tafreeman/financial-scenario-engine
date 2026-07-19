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

### Percent-Complete and Earned Value

When computing EVM for a project, the engine first checks for an explicit `percent_complete` value on the project record. If one is present it is clamped to [0, 100] and used directly:

```
EV = BAC × (percent_complete / 100)
```

#### Spend-ratio proxy (fallback)

When no explicit `percent_complete` is available, the engine falls back to the **spend ratio** as a proxy for physical progress:

```
EV = BAC × (spent_to_date / total_budget)
```

> **Disclosure — CPI/SPI limitations under the spend-ratio proxy**
>
> Deriving percent-complete from `AC / BAC` makes Earned Value a mathematical
> function of Actual Cost. This has two consequences that analysts must keep in
> mind:
>
> - **CPI (EV / AC) trends toward 1.0.** Because EV ≈ AC under this proxy,
>   Cost Performance Index loses sensitivity as a cost-efficiency signal — it
>   will appear near 1.0 even when the project is genuinely over- or
>   under-performing relative to planned cost.
> - **SPI (EV / PV) reflects spend pace, not physical progress.** Schedule
>   Performance Index measures how quickly budget is being consumed relative
>   to the time-phased plan, rather than how much deliverable work has actually
>   been completed.
>
> CPI and SPI are **not independent signals** under the proxy. They should be
> read as spend-pace indicators only. To obtain true performance indices,
> supply an explicit `percent_complete` value derived from physical progress
> (e.g. milestone gates, percent-complete reported by the PM, or a
> milestone-weighted earned-value method).

This treats the fraction of budget consumed as if it equals the fraction of work completed — a simplifying assumption that holds reasonably for cost-type contracts where spending closely tracks deliverable progress, but can diverge significantly for fixed-price or milestone-based contracts.

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
