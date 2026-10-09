import "server-only";
import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { ConfigError } from "@/lib/env";

/** An error whose message is safe to show the user, with its HTTP status. */
export class HttpError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

/** Converts thrown errors into safe JSON responses (no stack traces or secrets reach the client). */
export async function handle<T>(fn: () => Promise<T>): Promise<Response> {
  try {
    const result = await fn();
    if (result instanceof Response) return result;
    return NextResponse.json(result ?? { ok: true });
  } catch (e) {
    if (e instanceof HttpError) return NextResponse.json({ error: e.message }, { status: e.status });
    if (e instanceof ConfigError) return NextResponse.json({ error: e.message, code: "config" }, { status: 503 });
    if (e instanceof ZodError) {
      return NextResponse.json({ error: e.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; "), code: "invalid_input" }, { status: 400 });
    }
    console.error("Unhandled API error", e);
    return NextResponse.json({ error: "Something went wrong on the server. Please try again.", code: "internal" }, { status: 500 });
  }
}
