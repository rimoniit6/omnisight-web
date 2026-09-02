-- AlterTable
ALTER TABLE "OrganizationBranding" ADD COLUMN     "logoHeight" INTEGER,
ADD COLUMN     "logoSvg" TEXT,
ADD COLUMN     "logoType" TEXT,
ADD COLUMN     "logoWidth" INTEGER;

-- AlterTable
ALTER TABLE "PlatformBranding" ADD COLUMN     "logoHeight" INTEGER,
ADD COLUMN     "logoSvg" TEXT,
ADD COLUMN     "logoType" TEXT,
ADD COLUMN     "logoWidth" INTEGER;
