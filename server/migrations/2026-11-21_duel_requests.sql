-- v1.1204: запросы на изменение / удаление спора с согласием второго участника («Два ключа»)
create table if not exists public.habit_duel_requests (
  id bigserial primary key,
  duel_id bigint not null references public.habit_duels(id) on delete cascade,
  from_id bigint not null,
  kind text not null check (kind in ('edit', 'delete')),
  days integer,
  stake text,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'declined', 'cancelled', 'expired')),
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);
create unique index if not exists habit_duel_requests_one_pending on public.habit_duel_requests (duel_id) where status = 'pending';
create index if not exists habit_duel_requests_duel on public.habit_duel_requests (duel_id, id desc);
alter table public.habit_duel_requests enable row level security;
grant select, insert, update, delete on public.habit_duel_requests to service_role;
grant usage, select on all sequences in schema public to service_role;
