-- v1.1073: запасные заморозки серии за ⭐ (kind 'sfz'; у каждой покупки свой item, повторные покупки разрешены)
alter table public.streak_freezes add column if not exists paid boolean not null default false;
alter table public.shop_prices drop constraint if exists shop_prices_kind_check;
alter table public.shop_prices add constraint shop_prices_kind_check check (kind = any (array['frame','bg','kit','game','games','sfz']));
alter table public.shop_owned drop constraint if exists shop_owned_kind_check;
alter table public.shop_owned add constraint shop_owned_kind_check check (kind = any (array['frame','bg','kit','game','games','sfz']));
insert into public.shop_prices (kind, stars) values ('sfz', 15) on conflict (kind) do update set stars = excluded.stars;
