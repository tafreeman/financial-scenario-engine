# Narrative

`server/engine/narrative.ts` generates deterministic markdown narratives from a `ScenarioResult`. No LLM call — this is the default in the V2 pipeline when `use_llm_narrative: false`.

## Functions

### `generateNarrative(result)`

Convert a `ScenarioResult` into a formatted markdown string.

**Input:** `ScenarioResult`
**Output:** `string` (markdown)

```typescript
import { generateNarrative } from "./engine/index.js";

const markdown = generateNarrative(result);
```

## Output Format

The generated narrative includes:

1. **Heading** — Scenario type and project name
2. **Impact summary** — Key deltas (cost, revenue, margin, headcount)
3. **Before/after table** — Side-by-side comparison for mutation scenarios
4. **Warnings** — Any flags or concerns
5. **Recommendations** — Template-based suggestions

### Example Output

```markdown
## Staffing Swap Analysis — Project Alpha

### Impact Summary
| Metric | Change |
|--------|--------|
| Monthly Cost | -$1,950.00 |
| Monthly Revenue | -$3,250.00 |
| Margin | -2.1% |
| Headcount | +1 |

### Before vs. After
| Metric | Current | Projected |
|--------|---------|-----------|
| Monthly Burn | $62,500 | $60,550 |
| Margin % | 26.7% | 24.6% |
| Months Remaining | 12.8 | 13.2 |

⚠️ Margin decreased by 2.1 percentage points.
```
