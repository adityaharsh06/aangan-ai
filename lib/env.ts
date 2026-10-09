export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

const LABELS: Record<string, string> = {
  NEXT_PUBLIC_SUPABASE_URL: "Supabase project URL",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "Supabase publishable key",
  AANGAN_SERVICE_SECRET: "Aangan service secret",
  GEMINI_API_KEY: "Gemini API key",
  TELEGRAM_BOT_TOKEN: "Telegram bot token",
  TELEGRAM_DESIGNER_CHAT_ID: "Telegram designer chat id",
  VOICE_WEBHOOK_SECRET: "voice webhook secret",
};

export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim()) {
    throw new ConfigError(`${LABELS[name] ?? name} is not configured (missing ${name}).`);
  }
  return v.trim();
}

export function optionalEnv(name: string, fallback: string): string {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : fallback;
}

/** Numeric env var, or null when unset/invalid (null means "unavailable", never zero). */
export function numberEnv(name: string): number | null {
  const v = process.env[name];
  if (!v || !v.trim()) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function configStatus() {
  return {
    supabase: Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY && process.env.AANGAN_SERVICE_SECRET),
    gemini: Boolean(process.env.GEMINI_API_KEY?.trim()),
    telegram: Boolean(process.env.TELEGRAM_BOT_TOKEN?.trim() && process.env.TELEGRAM_DESIGNER_CHAT_ID?.trim()),
    voice: process.env.VAANI_WEBHOOK_SECRET?.trim() ? "vaani" : optionalEnv("VOICE_PROVIDER", "mock"),
    crm: optionalEnv("CRM_PROVIDER", "mock"),
    scheduling: process.env.CALENDLY_TOKEN?.trim() && process.env.CALENDLY_EVENT_TYPE_URI?.trim() ? "calendly" : "mock",
    model: optionalEnv("GEMINI_MODEL", "gemini-3.8-flash"),
  };
}
