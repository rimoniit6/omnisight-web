-- Full-organization cutover: deterministic cutover boundary timestamp.
ALTER TABLE "InfrastructureMigration" ADD COLUMN "cutoverAt" TIMESTAMP(3);