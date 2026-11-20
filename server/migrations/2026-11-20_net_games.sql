-- v1.988: игры по сети (приглашения, комнаты, присутствие). Всё читается и пишется только через edge-функцию STEPS (service_role).
create table if not exists public.net_presence (
  tg_id bigint primary key,
  seen timestamptz not null default now()
);
create table if not exists public.net_invites (
  id bigint generated always as identity primary key,
  from_id bigint not null,
  to_id bigint not null,
  status text not null default 'pending' check (status in ('pending','accepted','declined','expired','cancelled')),
  room_id uuid,
  tg_msg_id bigint,
  created_at timestamptz not null default now()
);
create index if not exists net_invites_to on public.net_invites (to_id, status, created_at desc);
create index if not exists net_invites_from on public.net_invites (from_id, created_at desc);
create table if not exists public.net_rooms (
  id uuid primary key default gen_random_uuid(),
  host_id bigint not null,
  guest_id bigint not null,
  game text check (game is null or game ~ '^[a-z0-9]{2,12}$'),
  status text not null default 'lobby' check (status in ('lobby','playing','done','closed')),
  guest_ready boolean not null default false,
  state jsonb not null default '{}'::jsonb,
  rev integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.net_presence enable row level security;
alter table public.net_invites enable row level security;
alter table public.net_rooms enable row level security;
grant select, insert, update, delete on table public.net_presence, public.net_invites, public.net_rooms to service_role;
