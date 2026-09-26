create table if not exists visits (
  id uuid primary key default gen_random_uuid(),
  worker_id text,
  worker_name text,
  household_id text,
  patient_name text,
  visit_date date default current_date,
  language text,
  raw_transcript text not null,
  symptoms text[] default '{}',
  vitals jsonb default '{}'::jsonb,
  vaccination_status text,
  follow_up_date date,
  status text not null default 'needs_follow_up'
    check (status in ('complete', 'needs_follow_up', 'flagged_for_review')),
  created_at timestamptz not null default now()
);
create index if not exists visits_created_at_idx on visits (created_at desc);

-- Phase 5: patient records and protocol-aware visits.
create table if not exists patients (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  date_of_birth date,
  dob_is_approximate boolean not null default false,
  sex text check (sex in ('female', 'male', 'other')),
  household_id text,
  village text,
  expected_delivery_date date,
  created_at timestamptz not null default now()
);
create index if not exists patients_name_idx on patients (lower(name));

alter table visits add column if not exists patient_id uuid references patients (id);
alter table visits add column if not exists protocol text;
alter table visits add column if not exists protocol_data jsonb not null default '{}'::jsonb;
create index if not exists visits_patient_idx on visits (patient_id, created_at desc);
