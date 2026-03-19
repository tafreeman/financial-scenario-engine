/** Generic fuzzy name matching for projects, roles, and labor categories */
export function fuzzyMatch<T>(
  query: string,
  items: T[],
  getName: (item: T) => string,
  abbrevMap?: Record<string, string>
): T | null {
  const lower = query.toLowerCase().trim();

  // Exact match
  const exact = items.find(item => getName(item).toLowerCase() === lower);
  if (exact) return exact;

  // Substring match (query within item name)
  const sub = items.find(item => getName(item).toLowerCase().includes(lower));
  if (sub) return sub;

  // Reverse substring (item name within query)
  const rev = items.find(item => lower.includes(getName(item).toLowerCase()));
  if (rev) return rev;

  // Abbreviation map lookup
  if (abbrevMap) {
    const mapped = abbrevMap[lower];
    if (mapped) {
      return items.find(item => getName(item).toLowerCase() === mapped) ?? null;
    }
  }

  // Keyword match (all words in query appear in item name)
  const keywords = lower.split(/\s+/);
  if (keywords.length > 1) {
    const kw = items.find(item => {
      const name = getName(item).toLowerCase();
      return keywords.every(k => name.includes(k));
    });
    if (kw) return kw;
  }

  // Single keyword partial match
  const partial = items.find(item => {
    const name = getName(item).toLowerCase();
    return keywords.some(k => name.includes(k));
  });
  return partial ?? null;
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
