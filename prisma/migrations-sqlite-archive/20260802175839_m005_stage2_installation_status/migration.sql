-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Installation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "joinKeyHash" TEXT NOT NULL,
    "joinKeyHint" TEXT,
    "minAgentVersion" TEXT NOT NULL DEFAULT '0.1.0',
    "status" TEXT NOT NULL DEFAULT 'Active',
    "settings" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_Installation" ("createdAt", "id", "joinKeyHash", "joinKeyHint", "minAgentVersion", "name", "settings", "updatedAt") SELECT "createdAt", "id", "joinKeyHash", "joinKeyHint", "minAgentVersion", "name", "settings", "updatedAt" FROM "Installation";
DROP TABLE "Installation";
ALTER TABLE "new_Installation" RENAME TO "Installation";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
