create table if not exists traffic_observations (
  id bigserial primary key,
  observed_at timestamptz not null,
  direction text not null,
  checkpoint text not null,
  source_updated_at timestamptz not null,
  camera_id text not null,
  image_url text not null,
  estimated_wait_minutes integer not null,
  forecast_30_minutes integer,
  method text not null,
  created_at timestamptz not null default now()
);

create unique index if not exists traffic_observations_source_unique
  on traffic_observations (direction, checkpoint, source_updated_at);

create index if not exists traffic_observations_lookup_idx
  on traffic_observations (direction, checkpoint, observed_at desc);

create table if not exists traveler_reports (
  id bigserial primary key,
  reported_at timestamptz not null,
  direction text not null,
  checkpoint text not null,
  actual_wait_minutes integer not null,
  estimated_wait_minutes integer,
  source_updated_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists traveler_reports_lookup_idx
  on traveler_reports (direction, checkpoint, reported_at desc);
