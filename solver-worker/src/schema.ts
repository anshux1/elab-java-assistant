import { z } from "zod";
import type { Issue } from "./errors";

const fieldSchema = z.object({
  label: z.string().trim().min(1).max(200),
  value: z.string().max(10_000)
});

const cardSchema = z.object({
  title: z.string().trim().min(1).max(200),
  fields: z.array(fieldSchema).max(30)
});

export const solveRequestSchema = z.object({
  language: z.string().trim().min(1).max(100),
  starterCode: z.string().max(30_000).refine((value) => value.trim().length > 0, "Starter code is empty"),
  problem: z.string().trim().min(1).max(20_000),
  functional: z.string().max(10_000).default(""),
  constraints: z.string().max(10_000).default(""),
  inputFormat: z.string().max(10_000).default(""),
  outputFormat: z.string().max(10_000).default(""),
  logical: z.array(cardSchema).max(50).default([]),
  mandatory: z.array(cardSchema).max(50).default([]),
  complexity: z.array(cardSchema).max(50).default([])
});

export type SolveRequest = z.infer<typeof solveRequestSchema>;

export type SolveUsage = {
  input?: number;
  output?: number;
};

export type SolveSuccess = {
  ok: true;
  code: string;
  model: string;
  cached?: boolean;
  usage?: SolveUsage;
  warnings?: Issue[];
};

export type SolveProgress = "solving" | "repairing" | "validating";
