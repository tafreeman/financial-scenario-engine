/** Match quality levels from best to worst */
export type MatchQuality = "exact" | "substring" | "reverse_substring" | "abbreviation" | "keyword" | "partial" | "none";

/** Result of a fuzzy match including confidence information */
export interface FuzzyMatchResult<T> {
  item: T | null;
  quality: MatchQuality;
  confidence: number; // 0.0 - 1.0
}

/** Confidence scores for each match quality level */
const CONFIDENCE_SCORES: Record<MatchQuality, number> = {
  exact: 1.0,
  substring: 0.85,
  reverse_substring: 0.7,
  abbreviation: 0.8,
  keyword: 0.6,
  partial: 0.4,
  none: 0,
};

/** Generic fuzzy name matching for projects, roles, and labor categories */
export function fuzzyMatch<T>(
  query: string,
  items: T[],
  getName: (item: T) => string,
  abbrevMap?: Record<string, string>
): T | null {
  return fuzzyMatchWithConfidence(query, items, getName, abbrevMap).item;
}

/** Generic fuzzy name matching with confidence scoring */
export function fuzzyMatchWithConfidence<T>(
  query: string,
  items: T[],
  getName: (item: T) => string,
  abbrevMap?: Record<string, string>
): FuzzyMatchResult<T> {
  const lower = query.toLowerCase().trim();

  // Exact match
  const exact = items.find(item => getName(item).toLowerCase() === lower);
  if (exact) return { item: exact, quality: "exact", confidence: CONFIDENCE_SCORES.exact };

  // Substring match (query within item name)
  const sub = items.find(item => getName(item).toLowerCase().includes(lower));
  if (sub) return { item: sub, quality: "substring", confidence: CONFIDENCE_SCORES.substring };

  // Reverse substring (item name within query)
  const rev = items.find(item => lower.includes(getName(item).toLowerCase()));
  if (rev) return { item: rev, quality: "reverse_substring", confidence: CONFIDENCE_SCORES.reverse_substring };

  // Abbreviation map lookup
  if (abbrevMap) {
    const mapped = abbrevMap[lower];
    if (mapped) {
      const abbrevResult = items.find(item => getName(item).toLowerCase() === mapped) ?? null;
      if (abbrevResult) return { item: abbrevResult, quality: "abbreviation", confidence: CONFIDENCE_SCORES.abbreviation };
    }
  }

  // Keyword match (all words in query appear in item name)
  const keywords = lower.split(/\s+/);
  if (keywords.length > 1) {
    const kw = items.find(item => {
      const name = getName(item).toLowerCase();
      return keywords.every(k => name.includes(k));
    });
    if (kw) return { item: kw, quality: "keyword", confidence: CONFIDENCE_SCORES.keyword };
  }

  // Single keyword partial match
  const partial = items.find(item => {
    const name = getName(item).toLowerCase();
    return keywords.some(k => name.includes(k));
  });
  if (partial) return { item: partial, quality: "partial", confidence: CONFIDENCE_SCORES.partial };

  return { item: null, quality: "none", confidence: 0 };
}

/** Merged abbreviation map for labor categories/roles */
export const ROLE_ABBREVIATIONS: Record<string, string> = {
  "pm": "project manager",
  "ba": "business analyst",
  "qa": "qa engineer",
  "sr dev": "senior developer",
  "sr developer": "senior developer",
  "senior dev": "senior developer",
  "mid dev": "mid-level developer",
  "mid developer": "mid-level developer",
  "jr dev": "junior developer",
  "jr developer": "junior developer",
  "junior dev": "junior developer",
  "architect": "lead architect",
  "scrum": "scrum master",
};
