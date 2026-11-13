-- Магазин: комплекты (рамка + фон одного стиля) за 39 ⭐
alter table public.shop_prices drop constraint if exists shop_prices_kind_check;
alter table public.shop_prices add constraint shop_prices_kind_check check (kind in ('frame','bg','kit'));
alter table public.shop_owned drop constraint if exists shop_owned_kind_check;
alter table public.shop_owned add constraint shop_owned_kind_check check (kind in ('frame','bg','kit'));
insert into public.shop_prices (kind, stars) values ('kit', 39) on conflict (kind) do update set stars = excluded.stars;
