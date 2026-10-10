import { optionalEnv, requireEnv } from "@/lib/env";

export type GeminiErrorKind = "config" | "transient" | "timeout" | "invalid_json" | "blocked" | "http";

export class GeminiError extends Error {
  kind: GeminiErrorKind;
  constructor(kind: GeminiErrorKind, message: string) {
    super(message);
    this.kind = kind;
    this.name = "GeminiError";
  }
}

export interface GeminiUsage {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  thoughtsTokenCount?: number;
  totalTokenCount?: number;
}

export interface GeminiResult<T = unknown> {
  data: T;
  modelVersion: string;
  usage?: GeminiUsage;
  latencyMs: number;
}

interface GenerateOptions {
  system: string;
  user: string;
  /** Gemini OpenAPI-subset response schema */
  schema: Record<string, unknown>;
  maxOutputTokens?: number;
  timeoutMs?: number;
  /** Phone turns must be fast: fewer retries, shorter timeout. */
  attempts?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function geminiModel(): string {
  return optionalEnv("GEMINI_MODEL", "gemini-3.8-flash");
}

export function geminiConfigured(): boolean {
  return Boolean(process.env.GEMINI_API_KEY?.trim());
}

/** Backup models (GEMINI_FALLBACK_MODELS, comma-separated) used when the primary's daily quota is spent. */
export function geminiModels(): string[] {
  const extra = optionalEnv("GEMINI_FALLBACK_MODELS", "").split(",").map((m) => m.trim()).filter(Boolean);
  return Array.from(new Set([geminiModel(), ...extra]));
}

/** Models whose daily quota ran out, with when to try them again (per server instance). */
const exhausted = new Map<string, number>();
const QUOTA_RETRY_MS = 30 * 60_000;

class QuotaExhausted extends GeminiError {
  constructor(model: string) {
    super("transient", `Gemini daily quota used up for ${model}`);
  }
}

/** Models that just answered "overloaded" (503), skipped briefly (per server instance). */
const overloaded = new Map<string, number>();
const OVERLOAD_SKIP_MS = 2 * 60_000;
/** A healthy Flash model answers these prompts in a few seconds; one that hasn't by now is queued behind demand. */
const PER_MODEL_MAX_MS = 8_000;

/**
 * One structured-JSON call at temperature 0. Retries 429/500/network errors with backoff. Moves on
 * to the next model in GEMINI_FALLBACK_MODELS when a model is overloaded (503), times out, keeps
 * failing, is unknown (404), or its daily quota is used up (free tier).
 */
export async function generateJson<T = unknown>(opts: GenerateOptions): Promise<GeminiResult<T>> {
  const now = Date.now();
  const usable = geminiModels().filter((m) => (exhausted.get(m) ?? 0) <= now && (overloaded.get(m) ?? 0) <= now);
  let lastErr: GeminiError | null = null;
  // Whole call, across models, stays within 1.5× one request's timeout so callers (and Vercel's limit) aren't blown.
  const deadline = now + (opts.timeoutMs ?? 20_000) * 1.5;
  for (const model of usable.length ? usable : geminiModels()) {
    if (lastErr && Date.now() > deadline) break;
    try {
      const left = Math.max(3_000, deadline - Date.now());
      return await generateWithModel<T>(model, { ...opts, timeoutMs: Math.min(opts.timeoutMs ?? 20_000, left, PER_MODEL_MAX_MS) });
    } catch (e) {
      if (e instanceof QuotaExhausted) exhausted.set(model, Date.now() + QUOTA_RETRY_MS);
      else if (e instanceof Overloaded || (e instanceof GeminiError && e.kind === "timeout")) overloaded.set(model, Date.now() + OVERLOAD_SKIP_MS);
      else if (!(e instanceof GeminiError) || !["transient", "timeout", "config"].includes(e.kind)) throw e;
      lastErr = e as GeminiError;
    }
  }
  throw lastErr ?? new GeminiError("transient", "Gemini unavailable");
}

class Overloaded extends GeminiError {
  constructor(model: string) {
    super("transient", `Gemini model ${model} is overloaded (HTTP 503)`);
  }
}

async function generateWithModel<T>(model: string, opts: GenerateOptions): Promise<GeminiResult<T>> {
  const key = requireEnv("GEMINI_API_KEY");
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const generationConfig: Record<string, unknown> = {
    temperature: 0,
    candidateCount: 1,
    responseMimeType: "application/json",
    responseSchema: opts.schema,
    maxOutputTokens: opts.maxOutputTokens ?? 4096,
  };
  // Live-call extraction doesn't need deliberate reasoning; default thinking off for latency + cost.
  const budget = optionalEnv("GEMINI_THINKING_BUDGET", "0");
  if (/^-?\d+$/.test(budget)) generationConfig.thinkingConfig = { thinkingBudget: Number(budget) };

  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: opts.system }] },
    contents: [{ role: "user", parts: [{ text: opts.user }] }],
    generationConfig,
  });

  const attempts = opts.attempts ?? 3;
  let lastErr: GeminiError | null = null;
  const started = Date.now();
  for (let attempt = 0; attempt < attempts; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 20_000);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": key },
        body,
        signal: ctrl.signal,
        cache: "no-store",
      });
      if (res.status === 429) {
        const detail = await res.text().catch(() => "");
        // A per-day quota won't recover with a short backoff: switch model instead.
        if (/PerDay/i.test(detail)) throw new QuotaExhausted(model);
      }
      // "High demand" spikes don't clear in seconds: try the next model instead of waiting.
      if (res.status === 503) throw new Overloaded(model);
      if (res.status === 429 || res.status >= 500) {
        lastErr = new GeminiError("transient", `Gemini returned HTTP ${res.status}`);
        await sleep(800 * 2 ** attempt + Math.random() * 300);
        continue;
      }
      const json = (await res.json().catch(() => null)) as {
        candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] }; finishReason?: string }[];
        promptFeedback?: { blockReason?: string };
        modelVersion?: string;
        usageMetadata?: GeminiUsage;
        error?: { message?: string };
      } | null;
      if (!res.ok) {
        const msg = json?.error?.message ?? `HTTP ${res.status}`;
        throw new GeminiError(res.status === 404 ? "config" : "http", `Gemini request rejected: ${msg}`);
      }
      if (json?.promptFeedback?.blockReason) throw new GeminiError("blocked", `Gemini blocked the request (${json.promptFeedback.blockReason})`);
      const cand = json?.candidates?.[0];
      const text = (cand?.content?.parts ?? []).filter((p) => !p.thought && typeof p.text === "string").map((p) => p.text).join("");
      if (!text) throw new GeminiError("invalid_json", `Gemini returned no content (finishReason ${cand?.finishReason ?? "unknown"})`);
      let data: T;
      try {
        data = JSON.parse(text) as T;
      } catch {
        throw new GeminiError("invalid_json", "Gemini returned invalid JSON");
      }
      return { data, modelVersion: json?.modelVersion ?? model, usage: json?.usageMetadata, latencyMs: Date.now() - started };
    } catch (e) {
      if (e instanceof GeminiError) throw e;
      // A model that didn't answer in time is unlikely to on a retry: let the caller try the next model.
      if ((e as Error).name === "AbortError") throw new GeminiError("timeout", `Gemini request timed out (${model})`);
      lastErr = new GeminiError("transient", `Network error calling Gemini: ${(e as Error).message}`);
      await sleep(600 * 2 ** attempt);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr ?? new GeminiError("transient", "Gemini unavailable");
}
