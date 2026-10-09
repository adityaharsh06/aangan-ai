import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { requireEnv } from "@/lib/env";

let service: SupabaseClient | null = null;

/**
 * The app's only database client (the app has no login: access is by link, for the founder's
 * office and the course instructor). It authenticates with the x-aangan-service header, which RLS
 * checks against a hash in aangan_private. Server-only: the secret never reaches the browser.
 */
export function serviceDb(): SupabaseClient {
  if (!service) {
    service = createClient(requireEnv("NEXT_PUBLIC_SUPABASE_URL"), requireEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY"), {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { "x-aangan-service": requireEnv("AANGAN_SERVICE_SECRET") } },
    });
  }
  return service;
}
