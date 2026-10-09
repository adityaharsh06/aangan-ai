/** Telegram Bot API sender (https://core.telegram.org/bots/api#sendmessage). */
export type SendResult =
  | { ok: true; externalId: string }
  | { ok: false; notConfigured: true; error: string }
  | { ok: false; notConfigured?: false; error: string; retryable: boolean };

export function telegramConfigured(target: "designer" | "alerts" = "designer"): boolean {
  const chat = target === "alerts" ? process.env.TELEGRAM_ALERTS_CHAT_ID || process.env.TELEGRAM_DESIGNER_CHAT_ID : process.env.TELEGRAM_DESIGNER_CHAT_ID;
  return Boolean(process.env.TELEGRAM_BOT_TOKEN?.trim() && chat?.trim());
}

export async function sendTelegram(target: "designer" | "alerts", html: string): Promise<SendResult> {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const chat = (target === "alerts" ? process.env.TELEGRAM_ALERTS_CHAT_ID || process.env.TELEGRAM_DESIGNER_CHAT_ID : process.env.TELEGRAM_DESIGNER_CHAT_ID)?.trim();
  if (!token || !chat) return { ok: false, notConfigured: true, error: "Telegram bot token / chat id not configured" };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text: html, parse_mode: "HTML", link_preview_options: { is_disabled: true } }),
      signal: ctrl.signal,
      cache: "no-store",
    });
    const json = (await res.json().catch(() => null)) as { ok?: boolean; result?: { message_id?: number }; description?: string } | null;
    if (res.ok && json?.ok) return { ok: true, externalId: String(json.result?.message_id ?? "") };
    return { ok: false, error: `Telegram ${res.status}: ${json?.description ?? "unknown error"}`, retryable: res.status === 429 || res.status >= 500 };
  } catch (e) {
    return { ok: false, error: `Telegram network error: ${(e as Error).message}`, retryable: true };
  } finally {
    clearTimeout(timer);
  }
}

export function esc(s: string | null | undefined): string {
  return (s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
