-- v1.1237: изменение названия и даты старта спора
alter table public.habit_duel_requests add column if not exists title text;
alter table public.habit_duel_requests add column if not exists start_day integer;
