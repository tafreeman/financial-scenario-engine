import { z } from "zod";
import type { ScenarioOperation } from "./types.js";

// ─── Sub-schema definitions ───────────────────────────────────────────────────

const staffAddSchema = z.object({
  role: z.string(),
  count: z.number(),
  hours_per_week: z.number().optional(),
});

const staffRemoveSchema = z.object({
  role: z.string(),
  count: z.number(),
  person_name: z.string().optional(),
});

const rateChangeSchema = z.object({
  role: z.string(),
  new_bill_rate: z.number().optional(),
  new_cost_rate: z.number().optional(),
});

const hoursChangeSchema = z.object({
  person_name: z.string(),
  new_hours_per_week: z.number(),
});

const additionalCostSchema = z.object({
  description: z.string(),
  amount: z.number(),
  is_recurring: z.boolean(),
  frequency_months: z.number().optional(),
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
  extension_months: z.number().optional(),
  additional_costs: z.array(additionalCostSchema).optional(),
  sub_operations: z.array(z.lazy(() => scenarioOperationSchema)).optional(),
  _fallback: z.boolean().optional(),
  _fallback_reason: z.string().optional(),
});
