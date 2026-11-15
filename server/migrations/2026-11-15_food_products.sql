-- VOOB · общая база продуктов для сканера штрихкодов (раздел «Приложения → Калории»)
-- Значения — на 100 г / 100 мл. Читает и пишет только Edge Function voob-food (service role).
create table if not exists public.food_products (
  code        text primary key check (code ~ '^[0-9]{6,14}$'),
  name        text not null check (char_length(name) between 2 and 90),
  brand       text not null default '' check (char_length(brand) <= 60),
  k           numeric(6,1) not null check (k between 0 and 950),
  p           numeric(5,1) not null check (p between 0 and 100),
  f           numeric(5,1) not null check (f between 0 and 100),
  c           numeric(5,1) not null check (c between 0 and 100),
  u           text not null default 'г' check (u in ('г','мл')),
  src         text not null default 'user' check (src in ('off','user','est')),
  conf        int  not null default 1,
  added_by    bigint,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists food_products_name_idx on public.food_products (lower(name));
create index if not exists food_products_by_user  on public.food_products (added_by, created_at);
alter table public.food_products enable row level security;
-- политик нет намеренно: прямой доступ с клиента закрыт, всё идёт через voob-food
