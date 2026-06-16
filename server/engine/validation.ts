import { z } from "zod";
import type { ScenarioOperation } from "./types.js";

// ─── Sub-schema definitions ───────────────────────────────────────────────────

const staffAddSchema = z.object({
  role: z.string().min(1),
  count: z.number().int().positive(),
  hours_per_week: z.number().positive().max(168).optional(),
});

const staffRemoveSchema = z.object({
  role: z.string().min(1),
  count: z.number().int().positive(),
  person_name: z.string().min(1).optional(),
});

const rateChangeSchema = z
  .object({
    role: z.string().min(1),
    new_bill_rate: z.number().positive().optional(),
    new_cost_rate: z.number().positive().optional(),
  })
  // Both rate fields are optional, but an entry supplying neither is a no-op
  // ("ghost mutation"): it parses cleanly yet changes nothing downstream.
  // Require at least one rate so such entries are rejected at the boundary.
  .refine(r => r.new_bill_rate !== undefined || r.new_cost_rate !== undefined, {
    message: "rate_change entry must supply at least one of new_bill_rate or new_cost_rate",
  });

const hoursChangeSchema = z.object({
  person_name: z.string().min(1),
  new_hours_per_week: z.number().positive().max(168),
});

const additionalCostSchema = z.object({
  description: z.string().min(1),
  amount: z.number().positive(),
  is_recurring: z.boolean(),
  frequency_months: z.number().int().positive().optional(),
});

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

// ─── Main schema (exported) ───────────────────────────────────────────────────

// Explicit ZodType annotation is required because TypeScript cannot infer
// recursive types from Zod without it (due to the z.lazy() in sub_operations).
export const scenarioOperationSchema: z.ZodType<ScenarioOperation> = z.object({
  action: actionEnum,
  project: z.string().optional(),
  projects: z.array(z.string()).optional(),
  remove: z.array(staffRemoveSchema).optional(),
  add: z.array(staffAddSchema).optional(),
  rate_changes: z.array(rateChangeSchema).optional(),
  hours_changes: z.array(hoursChangeSchema).optional(),
  new_end_date: z.string().optional(),
  extension_months: z.number().int().positive().optional(),
  additional_costs: z.array(additionalCostSchema).optional(),
  sub_operations: z.array(z.lazy(() => scenarioOperationSchema)).optional(),
  _fallback: z.boolean().optional(),
  _fallback_reason: z.string().optional(),
});
