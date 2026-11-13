-- Магазин: подарки другу. Владелец предмета — получатель, плательщик (для возврата звёзд) — в payer_id
alter table public.shop_owned add column if not exists payer_id bigint;
