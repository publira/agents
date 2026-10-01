import { z } from "zod";

export type LogFields = Record<
  string,
  boolean | number | string | null | undefined
>;

export type Log = (
  level: "error" | "info" | "warn",
  message: string,
  fields?: LogFields
) => void;

/**
 * Writes one JSON line. Callers pass the fields to record one by one, never a
 * whole payload, request, or error, so credentials and tokens stay out of the
 * logs.
 */
export const log: Log = (level, message, fields = {}) => {
  console[level](JSON.stringify({ level, message, ...fields }));
};

/**
 * The part of a thrown error that is safe to log: its message and, for a
 * failed GitHub request, the HTTP status, but not the request or response.
 */
export const loggableFailure = z
  .object({ message: z.string(), status: z.number().optional() })
  .transform(({ message, status }) => ({ error: message, status }));
