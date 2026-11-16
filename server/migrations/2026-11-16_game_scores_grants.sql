-- v1.879: у game_scores не было прав у service_role → «permission denied», рекорды не сохранялись и не читались
grant select, insert, update, delete on table public.game_scores to service_role;
