-- v1.1173: чит-дни по дням недели; у каждого игрока свой набор (создатель — при создании, друг — при принятии)
alter table public.habit_duels add column if not exists cheat_mode text not null default 'q';
alter table public.habit_duels add column if not exists from_wd integer[];
alter table public.habit_duels add column if not exists to_wd integer[];
