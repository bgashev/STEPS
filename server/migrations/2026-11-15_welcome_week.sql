-- Приветственная неделя, разрешение на сообщения от бота, напоминания (v1.832)
create table if not exists public.welcome_claims (
  tg_id bigint not null references public.users(tg_id) on delete cascade,
  day int not null,
  claimed_at timestamptz not null default now(),
  primary key (tg_id, day)
);
alter table public.welcome_claims enable row level security;
grant select, insert, update, delete on public.welcome_claims to service_role;

alter table public.users
  add column if not exists notify_ok boolean not null default false,
  add column if not exists remind_at timestamptz,
  add column if not exists remind_n int not null default 0;
grant select, update on public.users to service_role;
