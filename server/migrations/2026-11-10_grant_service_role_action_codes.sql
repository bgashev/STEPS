-- Коды из бота (отвязка Google, заморозка, удаление аккаунта) падали с «код устарел»:
-- у service_role не было прав на таблицу action_codes. Уже применено в проде.
GRANT SELECT, INSERT, UPDATE ON public.action_codes TO service_role;
