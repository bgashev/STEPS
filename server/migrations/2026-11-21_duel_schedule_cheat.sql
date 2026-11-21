-- v1.1165: расписание привычки в споре (d — каждый день, w — N раз в неделю, wd — дни недели, ev — раз в K дней) и чит-дни
alter table public.habit_duels add column if not exists sch_t text not null default 'd';
alter table public.habit_duels add column if not exists sch_n integer;
alter table public.habit_duels add column if not exists sch_d integer[];
alter table public.habit_duels add column if not exists sch_k integer;
alter table public.habit_duels add column if not exists cheat_w integer not null default 0;
alter table public.habit_duel_logs add column if not exists cheat boolean not null default false;
