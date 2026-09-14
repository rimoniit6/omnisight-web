-- AlterTable
ALTER TABLE "Screenshot" ADD COLUMN     "analysisFailed" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "piiRedacted" BOOLEAN NOT NULL DEFAULT false;
