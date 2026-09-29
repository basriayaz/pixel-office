import { AUTH_ERROR } from "./providers.js";

// A turn that failed for a passing reason (rate limit, overload, a network blip) is tried again after a wait instead of
// blocking the task at once. Only board task sessions retry: in the chat the boss is there and simply writes again.

// Waits before attempt 1, 2, 3. PIXEL_OFFICE_RETRY_MS="1000,2000" shortens them (tests).
const custom = (process.env.PIXEL_OFFICE_RETRY_MS ?? "").split(",").map(Number).filter((n) => n > 0);
export const RETRY_DELAYS_MS: number[] = custom.length ? custom : [30e3, 120e3, 300e3];

// What the three engines say when the provider is busy or out of reach for a while:
//   Claude: "API Error: 529 {"type":"overloaded_error",...}", "Request timed out", "Connection error.", 500/502/503
//   Gemini: "[429 Too Many Requests] RESOURCE_EXHAUSTED", "503 UNAVAILABLE: The model is overloaded", "fetch failed"
//   Codex: "stream disconnected before completion", "exceeded retry limit, last status: 429 Too Many Requests", "Rate limit reached"
const TRANSIENT = new RegExp([
  String.raw`\b(429|500|502|503|504|529)\b`,
  "too many requests", "rate.?limit", "RESOURCE_EXHAUSTED", "overloaded", "UNAVAILABLE", "DEADLINE_EXCEEDED", "internal server error",
  "bad gateway", "service unavailable", "gateway time-?out", "temporarily", "try again later",
  "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH", "EPIPE",
  "socket hang up", "fetch failed", "network error", "connection error", "stream disconnected", "timed? ?out",
].join("|"), "i");

// Looks passing but is not: a quota or a bill that a few minutes will not fix, a request the provider will never take.
const PERMANENT = /insufficient_quota|quota exceeded for .*per ?day|per day|daily limit|billing|credit balance|payment|usage limit|hit your limit|limit will reset|context.{0,20}(length|window)|too long|invalid_request|model .*not (found|supported)/i;

export function isTransient(error: string | undefined): boolean {
  if (!error) return false;
  return !AUTH_ERROR.test(error) && !PERMANENT.test(error) && TRANSIENT.test(error);
}

export function retryDelay(attempt: number): number | undefined {
  return RETRY_DELAYS_MS[attempt - 1];
}
