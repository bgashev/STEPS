-- Магазин VOOB: покупки рамок и фонов за Telegram Stars (навсегда)
create table if not exists public.shop_prices (
  kind text primary key check (kind in ('frame','bg')),
  stars int not null check (stars > 0)
);
insert into public.shop_prices (kind, stars) values ('frame', 30), ('bg', 25)
  on conflict (kind) do update set stars = excluded.stars;

create table if not exists public.shop_owned (
  id bigserial primary key,
  tg_id bigint not null,
  kind text not null check (kind in ('frame','bg')),
  item text not null check (item ~ '^[a-z0-9]{3,16}$'),
  stars int not null,
  charge_id text unique,
  created_at timestamptz not null default now(),
  refunded_at timestamptz,
  unique (tg_id, kind, item)
);
create index if not exists shop_owned_tg on public.shop_owned (tg_id) where refunded_at is null;
alter table public.shop_prices enable row level security;
alter table public.shop_owned enable row level security;
grant select, insert, update, delete on public.shop_prices, public.shop_owned to service_role;
grant usage, select on sequence public.shop_owned_id_seq to service_role;

-- идемпотентная запись покупки: повторный charge_id не создаёт дубль
create or replace function public.shop_apply_payment(p_tg bigint, p_kind text, p_item text, p_charge text, p_stars int)
returns table(dup boolean) language plpgsql security definer set search_path = public as $$
declare n int;
begin
  insert into shop_owned (tg_id, kind, item, stars, charge_id) values (p_tg, p_kind, p_item, p_stars, p_charge)
    on conflict do nothing;
  get diagnostics n = row_count;
  return query select n = 0;
end $$;
revoke all on function public.shop_apply_payment(bigint, text, text, text, int) from public, anon, authenticated;
grant execute on function public.shop_apply_payment(bigint, text, text, text, int) to service_role;
