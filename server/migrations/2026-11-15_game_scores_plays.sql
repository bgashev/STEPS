-- v1.878: счётчик партий и дата последней игры (статистика игр в VOOB CORE)
alter table public.game_scores add column if not exists plays integer not null default 0;
alter table public.game_scores add column if not exists last_played timestamptz;
alter table public.game_scores drop constraint if exists game_scores_best_check;
alter table public.game_scores add constraint game_scores_best_check check (best >= 0 and best < 1000000);
