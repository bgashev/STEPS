-- v1.1165: у service_role не было прав на таблицы споров и напоминаний (permission denied) -> спор не создавался, список приходил пустым
grant select, insert, update, delete on public.habit_duels, public.habit_duel_logs, public.habit_duel_events, public.habit_reminders to service_role;
grant usage, select on all sequences in schema public to service_role;
