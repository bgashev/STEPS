-- v1.1162: дата старта спора, выбранная при создании (день в формате lday); NULL = старт в день ответа друга
alter table public.habit_duels add column if not exists start_day integer;
