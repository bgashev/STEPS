-- v1.797: заявки на возврат; повторная покупка возвращённого предмета
alter table public.shop_owned drop constraint if exists shop_owned_tg_id_kind_item_key;
drop index if exists public.shop_owned_tg_id_kind_item_key;
create unique index if not exists shop_owned_live_uq on public.shop_owned (tg_id, kind, item) where refunded_at is null;

create table if not exists public.refund_requests (
  id bigserial primary key,
  tg_id bigint not null,
  charge_id text not null,
  src text not null check (src in ('pro','shop')),
  reason text not null,
  note text,
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  flags text,
  created_at timestamptz not null default now(),
  decided_at timestamptz
);
create unique index if not exists refund_requests_pending_uq on public.refund_requests (charge_id) where status = 'pending';
create index if not exists refund_requests_tg on public.refund_requests (tg_id, created_at desc);
alter table public.refund_requests enable row level security;
grant all on public.refund_requests to service_role;
grant usage, select on sequence public.refund_requests_id_seq to service_role;
