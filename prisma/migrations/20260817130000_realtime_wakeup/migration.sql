-- Realtime wake-up (R2): every INSERT/UPDATE on the tables the live-updates
-- poller broadcasts from fires pg_notify('omnisight_events', <table>). The
-- service LISTENs on that channel and wakes its poller immediately (debounced
-- 250 ms), cutting ingestion→delivery latency from up to 5 s to well under
-- 1 s. The notify is a wake signal only — the poller still reads the DB and
-- broadcasts through the org-scoped, row-derived path; the durable cursor and
-- the 5 s poll remain as catch-up/recovery.
--
-- IDEMPOTENT: the live-updates service recreates these triggers at boot
-- (mini-services/live-updates/notify-triggers.ts), so a fresh deploy on a DB
-- where the service already ran must not fail on duplicate triggers. DROPs
-- therefore come BEFORE the CREATEs.

CREATE OR REPLACE FUNCTION omnisight_notify_event() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('omnisight_events', TG_TABLE_NAME);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS omnisight_notify_device ON "Device";
DROP TRIGGER IF EXISTS omnisight_notify_activity ON "Activity";
DROP TRIGGER IF EXISTS omnisight_notify_notification ON "Notification";
DROP TRIGGER IF EXISTS omnisight_notify_screenshot ON "Screenshot";
DROP TRIGGER IF EXISTS omnisight_notify_agentregistration ON "AgentRegistration";
DROP TRIGGER IF EXISTS omnisight_notify_usbevent ON "UsbEvent";
DROP TRIGGER IF EXISTS omnisight_notify_timeentry ON "TimeEntry";
DROP TRIGGER IF EXISTS omnisight_notify_deviceclaim ON "DeviceClaim";
DROP TRIGGER IF EXISTS omnisight_notify_anomaly ON "Anomaly";
DROP TRIGGER IF EXISTS omnisight_notify_applistentry ON "AppListEntry";
DROP TRIGGER IF EXISTS omnisight_notify_policyviolation ON "PolicyViolation";
DROP TRIGGER IF EXISTS omnisight_notify_alert ON "Alert";
DROP TRIGGER IF EXISTS omnisight_notify_guest ON "Guest";
DROP TRIGGER IF EXISTS omnisight_notify_agentbuild ON "AgentBuild";

CREATE TRIGGER omnisight_notify_device AFTER INSERT OR UPDATE ON "Device" FOR EACH ROW EXECUTE FUNCTION omnisight_notify_event();
CREATE TRIGGER omnisight_notify_activity AFTER INSERT OR UPDATE ON "Activity" FOR EACH ROW EXECUTE FUNCTION omnisight_notify_event();
CREATE TRIGGER omnisight_notify_notification AFTER INSERT OR UPDATE ON "Notification" FOR EACH ROW EXECUTE FUNCTION omnisight_notify_event();
CREATE TRIGGER omnisight_notify_screenshot AFTER INSERT OR UPDATE ON "Screenshot" FOR EACH ROW EXECUTE FUNCTION omnisight_notify_event();
CREATE TRIGGER omnisight_notify_agentregistration AFTER INSERT OR UPDATE ON "AgentRegistration" FOR EACH ROW EXECUTE FUNCTION omnisight_notify_event();
CREATE TRIGGER omnisight_notify_usbevent AFTER INSERT OR UPDATE ON "UsbEvent" FOR EACH ROW EXECUTE FUNCTION omnisight_notify_event();
CREATE TRIGGER omnisight_notify_timeentry AFTER INSERT OR UPDATE ON "TimeEntry" FOR EACH ROW EXECUTE FUNCTION omnisight_notify_event();
CREATE TRIGGER omnisight_notify_deviceclaim AFTER INSERT OR UPDATE ON "DeviceClaim" FOR EACH ROW EXECUTE FUNCTION omnisight_notify_event();
CREATE TRIGGER omnisight_notify_anomaly AFTER INSERT OR UPDATE ON "Anomaly" FOR EACH ROW EXECUTE FUNCTION omnisight_notify_event();
CREATE TRIGGER omnisight_notify_applistentry AFTER INSERT OR UPDATE ON "AppListEntry" FOR EACH ROW EXECUTE FUNCTION omnisight_notify_event();
CREATE TRIGGER omnisight_notify_policyviolation AFTER INSERT OR UPDATE ON "PolicyViolation" FOR EACH ROW EXECUTE FUNCTION omnisight_notify_event();
CREATE TRIGGER omnisight_notify_alert AFTER INSERT OR UPDATE ON "Alert" FOR EACH ROW EXECUTE FUNCTION omnisight_notify_event();
CREATE TRIGGER omnisight_notify_guest AFTER INSERT OR UPDATE ON "Guest" FOR EACH ROW EXECUTE FUNCTION omnisight_notify_event();
CREATE TRIGGER omnisight_notify_agentbuild AFTER INSERT OR UPDATE ON "AgentBuild" FOR EACH ROW EXECUTE FUNCTION omnisight_notify_event();
