# Matching

`server/engine/matching.ts` provides fuzzy role-name matching for resolving natural-language role references to labor categories in the rate card.

## Functions

### `fuzzyMatch(input, categories)`

Returns the best-matching labor category name.

```typescript
import { fuzzyMatch } from "./engine/index.js";

fuzzyMatch("Sr Dev", categories);
// → "Senior Developer"

fuzzyMatch("QA", categories);
// → "QA Engineer"
```

---

### `fuzzyMatchWithConfidence(input, categories)`

Returns the match with a confidence score (0–1).

```typescript
const { match, confidence } = fuzzyMatchWithConfidence("Sr Dev", categories);
// → { match: "Senior Developer", confidence: 0.85 }
```

## Role Abbreviations

The module exports a `ROLE_ABBREVIATIONS` dictionary for common aliases:

| Abbreviation | Resolves to |
|-------------|------------|
| `Sr Dev` | Senior Developer |
| `Mid Dev` | Mid-level Developer |
| `Jr Dev` | Junior Developer |
| `QA` | QA Engineer |
| `PM` | Project Manager |
| `BA` | Business Analyst |
| `SA` | Solutions Architect |
| `DevOps` | DevOps Engineer |
