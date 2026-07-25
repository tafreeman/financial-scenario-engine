import { z } from "zod";
import type { ScenarioOperation } from "./types.js";

// ─── Sub-schema definitions ───────────────────────────────────────────────────
// Every object schema is `.strict()`: LLM-produced output is untrusted, so an
// unknown key (a hallucinated field, an injected parameter, a stray reasoning
// blob) is rejected at the boundary rather than carried into the engine.

const staffAddSchema = z
  .object({
    role: z.string().min(1),
    count: z.number().int().positive(),
    hours_per_week: z.number().positive().max(168).optional(),
  })
  .strict();

const staffRemoveSchema = z
  .object({
    role: z.string().min(1),
    count: z.number().int().positive(),
    person_name: z.string().min(1).optional(),
  })
  .strict();

const rateChangeSchema = z
  .object({
    role: z.string().min(1),
    new_bill_rate: z.number().positive().optional(),
    new_cost_rate: z.number().positive().optional(),
  })
  .strict()
  // Both rate fields are optional, but an entry supplying neither is a no-op
  // ("ghost mutation"): it parses cleanly yet changes nothing downstream.
  // Require at least one rate so such entries are rejected at the boundary.
  .refine(r => r.new_bill_rate !== undefined || r.new_cost_rate !== undefined, {
    message: "rate_change entry must supply at least one of new_bill_rate or new_cost_rate",
  });

const hoursChangeSchema = z
  .object({
    person_name: z.string().min(1),
    new_hours_per_week: z.number().positive().max(168),
  })
  .strict();

const additionalCostSchema = z
  .object({
    description: z.string().min(1),
    amount: z.number().positive(),
    is_recurring: z.boolean(),
    frequency_months: z.number().int().positive().optional(),
  })
  .strict();

const actionEnum = z.enum([
  "swap",
  "add",
  "remove",
  "rate_change",
  "hours_change",
  "timeline_extension",
  "unexpected_cost",
  "reallocation",
  "burn_rate_check",
  "margin_analysis",
  "evm_analysis",
  "what_if_composite",
]);

/** True for a payload array the engine can act on — `undefined` and `[]` are both no-ops. */
function hasEntries(payload: unknown): boolean {
  return Array.isArray(payload) && payload.length > 0;
}

// ─── Main schema (exported) ───────────────────────────────────────────────────

// Explicit ZodType annotation is required because TypeScript cannot infer
// recursive types from Zod without it (due to the z.lazy() in sub_operations).
// `.strict()` here also makes every nested sub_operation strict via the z.lazy
// self-reference, so unknown keys are rejected at any depth.
export const scenarioOperationSchema: z.ZodType<ScenarioOperation> = z
  .object({
    action: actionEnum,
    project: z.string().optional(),
    projects: z.array(z.string()).optional(),
    remove: z.array(staffRemoveSchema).optional(),
    add: z.array(staffAddSchema).optional(),
    rate_changes: z.array(rateChangeSchema).optional(),
    hours_changes: z.array(hoursChangeSchema).optional(),
    new_end_date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "new_end_date must be an ISO calendar date (YYYY-MM-DD)")
      // Round-trip rejects impossible dates that JS silently rolls over
      // (e.g. 2026-02-30 -> 2026-03-02), which Date.parse alone accepts. The NaN
      // guard must run first so an unparseable string short-circuits before
      // toISOString(), which would otherwise throw RangeError on an Invalid Date.
      .refine(s => {
        const parsed = new Date(`${s}T00:00:00Z`);
        return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === s;
      }, { message: "new_end_date must be a real calendar date" })
      .optional(),
    extension_months: z.number().int().positive().optional(),
    additional_costs: z.array(additionalCostSchema).optional(),
    sub_operations: z.array(z.lazy(() => scenarioOperationSchema)).optional(),
    _fallback: z.boolean().optional(),
    _fallback_reason: z.string().optional(),
  })
  .strict()
  // Every payload field above is `.optional()` because no single action uses
  // them all. The side effect is that a mutation action parses cleanly while
  // carrying nothing to mutate: `{action:"add",project:"X"}` validated, ran,
  // and came back with an all-zero impact that reads exactly like a real
  // answer. That is the same "ghost mutation" class rateChangeSchema rejects
  // one level down (see above), applied at the operation level.
  //
  // Each requirement below is what executor.ts actually reads for that action.
  // A missing payload calls the corresponding apply*/calc* helper with
  // `undefined`, and every one of those short-circuits to "unchanged" (see
  // scenarios.ts) — an empty array hits the same short-circuit, so `[]` is
  // rejected exactly like a missing key.
  .superRefine((operation, ctx) => {
    const requirePayload = (present: boolean, fields: string, path: string): void => {
      if (present) return;
      ctx.addIssue({
        code: "custom",
        path: [path],
        message:
          `${operation.action} operation must supply ${fields} — without it the ` +
          "operation parses cleanly but executes as a zero-impact no-op",
      });
    };

    switch (operation.action) {
      // Read-only analyses: the executor reads no payload for these, and the
      // documented burn_rate_check fallback (server/ai.ts) is exactly this shape.
      case "burn_rate_check":
      case "margin_analysis":
      case "evm_analysis":
        break;

      // applySwap = applyRemove ∘ applyAdd; either half alone still mutates the
      // roster, so requiring both would reject a one-sided swap that does have impact.
      case "swap":
        requirePayload(
          hasEntries(operation.remove) || hasEntries(operation.add),
          "remove[] or add[]", "remove"
        );
        break;

      case "add":
        requirePayload(hasEntries(operation.add), "add[]", "add");
        break;

      case "remove":
        requirePayload(hasEntries(operation.remove), "remove[]", "remove");
        break;

      case "rate_change":
        requirePayload(hasEntries(operation.rate_changes), "rate_changes[]", "rate_changes");
        break;

      case "hours_change":
        requirePayload(hasEntries(operation.hours_changes), "hours_changes[]", "hours_changes");
        break;

      // calcTimelineExtensionImpact takes either form and returns a zero-month
      // no-op when neither is supplied.
      case "timeline_extension":
        requirePayload(
          operation.extension_months !== undefined || operation.new_end_date !== undefined,
          "extension_months or new_end_date", "extension_months"
        );
        break;

      case "unexpected_cost":
        requirePayload(hasEntries(operation.additional_costs), "additional_costs[]", "additional_costs");
        break;

      // handleReallocation replays remove[] on the source and add[] on the
      // destination. The fewer-than-two-projects case is deliberately NOT
      // rejected here: the executor already warns and degrades to a portfolio
      // burn-rate check, which is loud rather than silent.
      case "reallocation":
        requirePayload(
          hasEntries(operation.remove) || hasEntries(operation.add),
          "remove[] or add[]", "remove"
        );
        break;

      // Nested no-ops need no special handling: sub_operations is recursive via
      // z.lazy, so every sub-operation is parsed by this same schema and faces
      // this same requirement.
      case "what_if_composite":
        requirePayload(hasEntries(operation.sub_operations), "sub_operations[]", "sub_operations");
        break;

      default: {
        // Exhaustiveness guard: a newly-added action must declare whether it
        // requires a payload, the same way executor.ts forces it a handler.
        const _exhaustive: never = operation.action;
        void _exhaustive;
      }
    }
  });
