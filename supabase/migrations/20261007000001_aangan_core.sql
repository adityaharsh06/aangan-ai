-- Aangan AI core schema. All objects are prefixed `aangan_` so they can share a Supabase
-- project with other apps without collisions.
--
-- Access model
--   * Staff (signed-in users whose email is in aangan_staff) can read everything and record overrides.
--   * The server pipeline (voice webhooks, dispatch) authenticates with the `x-aangan-service`
--     request header. Its SHA-256 is stored in aangan_private; the plaintext lives only in server env.
--   * Nobody else can read or write anything.

create schema if not exists aangan_private;
revoke all on schema aangan_private from public, anon, authenticated;

create table if not exists aangan_private.service_secret (
  id int primary key default 1 check (id = 1),
  secret_sha256 text not null,
  rotated_at timestamptz not null default now()
);

create table if not exists public.aangan_staff (
  email text primary key check (email = lower(email)),
  display_name text,
  role text not null default 'staff' check (role in ('founder', 'front_desk', 'designer', 'staff')),
  created_at timestamptz not null default now()
);

create or replace function public.aangan_is_service() returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare h text;
begin
  h := nullif(current_setting('request.headers', true), '')::json ->> 'x-aangan-service';
  if h is null or length(h) < 24 then return false; end if;
  return exists (
    select 1 from aangan_private.service_secret
    where secret_sha256 = encode(extensions.digest(h, 'sha256'), 'hex')
  );
end $$;

create or replace function public.aangan_is_staff() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.aangan_staff where email = lower(coalesce(auth.jwt() ->> 'email', '')));
$$;

create or replace function public.aangan_can_read() returns boolean
language sql stable set search_path = '' as $$
  select public.aangan_is_service() or public.aangan_is_staff();
$$;

-- ------------------------------------------------------------------ contacts
create table if not exists public.aangan_contacts (
  id uuid primary key default gen_random_uuid(),
  phone text not null unique,               -- normalised; duplicate detection key
  name text,
  email text,
  crm_external_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ------------------------------------------------------------------ enquiries
create table if not exists public.aangan_enquiries (
  id uuid primary key default gen_random_uuid(),
  contact_id uuid references public.aangan_contacts(id) on delete set null,
  source text not null default 'phone' check (source in ('phone', 'whatsapp', 'web')),
  call_type text not null default 'unknown' check (call_type in ('new_enquiry', 'existing_client', 'follow_up', 'other', 'unknown')),
  status text not null default 'in_progress' check (status in ('in_progress', 'qualified', 'unqualified', 'needs_review', 'escalated', 'incomplete', 'other')),
  received_at timestamptz not null,
  first_response_at timestamptz,
  response_seconds numeric,
  within_sla boolean,
  after_hours boolean not null default false,
  facts jsonb not null default '{}'::jsonb,
  criteria jsonb not null default '[]'::jsonb,
  qualification_reasons text[] not null default '{}',
  uncertainty_notes text[] not null default '{}',
  pricing_asked boolean not null default false,
  summary text,
  caller_concerns text[] not null default '{}',
  recommended_next_action text,
  preferred_slots text[] not null default '{}',
  handoff_status text not null default 'not_required' check (handoff_status in ('not_required', 'pending', 'sent', 'failed', 'not_configured')),
  handoff_sent_at timestamptz,
  crm_status text not null default 'pending_integration',
  scheduling_status text not null default 'not_applicable',
  knowledge_version text,
  extraction_mode text,
  closed_at timestamptz,
  override_status text,
  override_reason text,
  override_by text,
  override_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists aangan_enquiries_received_idx on public.aangan_enquiries (received_at desc);
create index if not exists aangan_enquiries_contact_idx on public.aangan_enquiries (contact_id, received_at desc);

-- ------------------------------------------------------------------ calls
create table if not exists public.aangan_calls (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  provider_call_id text not null,
  enquiry_id uuid not null references public.aangan_enquiries(id) on delete cascade,
  from_number text,
  started_at timestamptz not null,
  answered_at timestamptz,
  ended_at timestamptz,
  duration_seconds numeric,
  end_reason text,
  status text not null default 'in_progress' check (status in ('in_progress', 'completed', 'dropped', 'missed')),
  session jsonb not null default '{}'::jsonb,   -- facts + dialogue state + turns
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider, provider_call_id)
);
create index if not exists aangan_calls_enquiry_idx on public.aangan_calls (enquiry_id);

-- ------------------------------------------------------------------ idempotency for inbound webhook events
create table if not exists public.aangan_webhook_events (
  provider text not null,
  event_id text not null,
  received_at timestamptz not null default now(),
  response jsonb,
  primary key (provider, event_id)
);

-- ------------------------------------------------------------------ outbox (Telegram, CRM, scheduling)
create table if not exists public.aangan_outbox (
  id uuid primary key default gen_random_uuid(),
  enquiry_id uuid references public.aangan_enquiries(id) on delete cascade,
  channel text not null check (channel in ('telegram', 'crm', 'scheduling')),
  kind text not null,
  idempotency_key text not null unique,
  payload jsonb not null,
  status text not null default 'pending' check (status in ('pending', 'sent', 'failed', 'not_configured')),
  attempts int not null default 0,
  last_error text,
  external_id text,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  next_attempt_at timestamptz not null default now()
);
create index if not exists aangan_outbox_due_idx on public.aangan_outbox (status, next_attempt_at);

-- ------------------------------------------------------------------ audit trail
create table if not exists public.aangan_events (
  id bigint generated always as identity primary key,
  enquiry_id uuid references public.aangan_enquiries(id) on delete cascade,
  call_id uuid references public.aangan_calls(id) on delete set null,
  event text not null,
  status text not null default 'ok' check (status in ('ok', 'error', 'info', 'warning')),
  external_id text,
  error text,
  metadata jsonb not null default '{}'::jsonb,
  at timestamptz not null default now()
);
create index if not exists aangan_events_enquiry_idx on public.aangan_events (enquiry_id, at);
create index if not exists aangan_events_at_idx on public.aangan_events (at desc);

-- ------------------------------------------------------------------ cost tracking
create table if not exists public.aangan_cost_events (
  id bigint generated always as identity primary key,
  enquiry_id uuid references public.aangan_enquiries(id) on delete cascade,
  call_id uuid references public.aangan_calls(id) on delete set null,
  provider text not null,                     -- gemini | voice | telegram
  units numeric not null,
  unit text not null,                          -- input_tokens | output_tokens | minutes | messages
  cost_inr numeric,                            -- null = price unavailable
  basis text not null check (basis in ('actual', 'estimated', 'configured', 'unavailable')),
  metadata jsonb not null default '{}'::jsonb,
  at timestamptz not null default now()
);
create index if not exists aangan_cost_at_idx on public.aangan_cost_events (at desc);

-- ------------------------------------------------------------------ RLS
do $$
declare t text;
begin
  foreach t in array array['aangan_contacts', 'aangan_enquiries', 'aangan_calls', 'aangan_webhook_events', 'aangan_outbox', 'aangan_events', 'aangan_cost_events'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I on public.%I', t || '_read', t);
    execute format('create policy %I on public.%I for select to anon, authenticated using (public.aangan_can_read())', t || '_read', t);
    execute format('drop policy if exists %I on public.%I', t || '_svc_insert', t);
    execute format('create policy %I on public.%I for insert to anon, authenticated with check (public.aangan_is_service())', t || '_svc_insert', t);
    execute format('drop policy if exists %I on public.%I', t || '_svc_update', t);
    execute format('create policy %I on public.%I for update to anon, authenticated using (public.aangan_is_service()) with check (public.aangan_is_service())', t || '_svc_update', t);
  end loop;
end $$;

alter table public.aangan_staff enable row level security;
drop policy if exists aangan_staff_read on public.aangan_staff;
create policy aangan_staff_read on public.aangan_staff for select to authenticated using (public.aangan_is_staff());

-- Staff correction of an automated outcome. Recorded, attributed and audited; never silent.
create or replace function public.aangan_override(p_enquiry uuid, p_status text, p_reason text)
returns void language plpgsql security definer set search_path = '' as $$
declare who text := lower(coalesce(auth.jwt() ->> 'email', ''));
declare prev text;
begin
  if not public.aangan_is_staff() then raise exception 'not authorised' using errcode = '42501'; end if;
  if p_status not in ('qualified', 'unqualified', 'needs_review', 'escalated', 'other') then raise exception 'invalid status'; end if;
  if coalesce(length(trim(p_reason)), 0) < 5 then raise exception 'a reason is required'; end if;
  select status into prev from public.aangan_enquiries where id = p_enquiry for update;
  if prev is null then raise exception 'enquiry not found'; end if;
  update public.aangan_enquiries
     set status = p_status, override_status = p_status, override_reason = trim(p_reason), override_by = who,
         override_at = now(), updated_at = now(),
         handoff_status = case when p_status = 'qualified' and handoff_status in ('not_required') then 'pending' else handoff_status end
   where id = p_enquiry;
  insert into public.aangan_events (enquiry_id, event, status, metadata)
  values (p_enquiry, 'status.overridden', 'info', jsonb_build_object('from', prev, 'to', p_status, 'reason', trim(p_reason), 'by', who));
end $$;

revoke all on function public.aangan_override(uuid, text, text) from public, anon;
grant execute on function public.aangan_override(uuid, text, text) to authenticated;
grant execute on function public.aangan_is_service() to anon, authenticated;
grant execute on function public.aangan_is_staff() to anon, authenticated;
grant execute on function public.aangan_can_read() to anon, authenticated;
