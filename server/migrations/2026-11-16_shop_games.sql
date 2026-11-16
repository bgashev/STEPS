-- v1.883: PRO-игры за ⭐ навсегда: «game» (одна игра, ⭐19) и «games» (все сразу, ⭐99)
alter table public.shop_prices drop constraint if exists shop_prices_kind_check;
alter table public.shop_prices add constraint shop_prices_kind_check check (kind = any (array['frame','bg','kit','game','games']));
alter table public.shop_owned drop constraint if exists shop_owned_kind_check;
alter table public.shop_owned add constraint shop_owned_kind_check check (kind = any (array['frame','bg','kit','game','games']));
insert into public.shop_prices (kind, stars) values ('game', 19), ('games', 99) on conflict (kind) do update set stars = excluded.stars;
