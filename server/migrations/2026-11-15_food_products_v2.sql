-- VOOB · общая база продуктов v2: модерация пользовательских записей + разовый ключ импорта
alter table public.food_products add column if not exists status text not null default 'ok' check (status in ('ok','pending'));
alter table public.food_products add column if not exists confirmers bigint[] not null default '{}';
create index if not exists food_products_status_idx on public.food_products (status);
create table if not exists public.food_admin (k text primary key, v text not null);
alter table public.food_admin enable row level security;
