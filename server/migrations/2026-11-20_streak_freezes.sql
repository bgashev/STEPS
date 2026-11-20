-- Заморозка серии (v1.1070): один пропущенный день закрывается заморозкой, серия не рвётся.
-- day — номер дня (дни с 1970-01-01 по дате Астаны, как lday/dn), seen — показан ли пользователю экран «Серия спасена».
create table if not exists public.streak_freezes (
  tg_id bigint not null references public.users(tg_id) on delete cascade,
  day int not null,
  seen boolean not null default false,
  created_at timestamptz not null default now(),
  primary key (tg_id, day)
);
alter table public.streak_freezes enable row level security;
grant select, insert, update, delete on public.streak_freezes to service_role;
