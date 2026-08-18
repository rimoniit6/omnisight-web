-- Remove Daily Intelligence feature tables (added via db push, now unused).
-- Tables are empty; DROP IF EXISTS keeps this safe on fresh databases too.

DROP TABLE IF EXISTS "DailyEmployeeSummary";
DROP TABLE IF EXISTS "DailyTeamSummary";
DROP TABLE IF EXISTS "DailyDepartmentSummary";
