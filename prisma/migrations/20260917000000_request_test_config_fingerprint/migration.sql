-- OmniSight — bind connection-test evidence to the exact tested configuration.
--
-- The transfer gate must prove that the successful test belongs to the SAME
-- config the request will migrate to (forensic findings RC-1 / R-1). The
-- server-computed fingerprint of the tested config is stored alongside the
-- existing lastTest* evidence on the request row.

ALTER TABLE "InfrastructureChangeRequest"
  ADD COLUMN "lastTestConfigFingerprint" TEXT;
