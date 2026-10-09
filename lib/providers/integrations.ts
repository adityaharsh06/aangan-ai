/**
 * CRM (HubSpot, later phase) and scheduling (Calendly). Until a system is connected its mock
 * adapter accepts the work and reports it as "not configured", so every lead is queued in the
 * outbox and can be replayed into the real system once it is connected.
 */
import { calendlyConfigured, calendlyScheduling } from "./calendly";

export interface CrmLead {
  enquiryId: string;
  phone: string;
  name: string | null;
  email: string | null;
  status: string;
  summary: string | null;
  facts: Record<string, unknown>;
  receivedAt: string;
}

export interface ProviderResult {
  ok: boolean;
  notConfigured?: boolean;
  externalId?: string;
  error?: string;
  retryable?: boolean;
}

export interface CRMProvider {
  readonly name: string;
  upsertLead(lead: CrmLead): Promise<ProviderResult>;
}

export interface BookingRequest {
  enquiryId: string;
  phone: string;
  name: string | null;
  email: string | null;
  /** The caller's preferred times, in their words. */
  slots: string[];
  siteVisit: boolean;
  site: string | null;
}

export interface BookingResult extends ProviderResult {
  /** "booked": a slot matching the caller's preference was booked; "link": a single-use booking link for the designer to send. */
  outcome?: "booked" | "link";
  startTime?: string;
  startLabel?: string;
  cancelUrl?: string;
  rescheduleUrl?: string;
  bookingUrl?: string;
  reason?: string;
}

export interface SchedulingProvider {
  readonly name: string;
  /** Book the consultation after the call, from the caller's stated preference. */
  book(input: BookingRequest): Promise<BookingResult>;
}

export const mockCrm: CRMProvider = {
  name: "mock",
  async upsertLead() {
    return { ok: false, notConfigured: true, error: "CRM integration (HubSpot) not connected yet; queued for replay" };
  },
};

export const mockScheduling: SchedulingProvider = {
  name: "mock",
  async book() {
    return { ok: false, notConfigured: true, error: "Scheduling integration (Calendly) not connected yet; preferred slots kept on the lead" };
  },
};

export function getCrm(): CRMProvider {
  return mockCrm;
}

export function getScheduling(): SchedulingProvider {
  return calendlyConfigured() ? calendlyScheduling : mockScheduling;
}
