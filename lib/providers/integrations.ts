/**
 * CRM (HubSpot) and scheduling (Calendly) are integrated in later phases. Until then these
 * mock adapters accept the work and report it as "not configured", so every lead is queued in
 * the outbox and can be replayed into the real systems once they are connected.
 */
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

export interface SchedulingProvider {
  readonly name: string;
  /** Record the caller's preferred consultation slots against the lead (no booking is promised). */
  proposeSlots(input: { enquiryId: string; phone: string; name: string | null; slots: string[]; siteVisit: boolean }): Promise<ProviderResult>;
}

export const mockCrm: CRMProvider = {
  name: "mock",
  async upsertLead() {
    return { ok: false, notConfigured: true, error: "CRM integration (HubSpot) not connected yet; queued for replay" };
  },
};

export const mockScheduling: SchedulingProvider = {
  name: "mock",
  async proposeSlots() {
    return { ok: false, notConfigured: true, error: "Scheduling integration (Calendly) not connected yet; preferred slots kept on the lead" };
  },
};

export function getCrm(): CRMProvider {
  return mockCrm;
}

export function getScheduling(): SchedulingProvider {
  return mockScheduling;
}
