import { prisma } from './prisma';

export async function initLauncherConfigsTable() {
  console.log('[LauncherConfig] Ensuring LauncherIconConfig table exists in PostgreSQL...');

  // Create table if not exists
  await prisma.$executeRawUnsafe(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'AppTypeEnum') THEN
        CREATE TYPE "AppTypeEnum" AS ENUM ('CUSTOMER', 'SELLER', 'ADMIN');
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'AppPlatformEnum') THEN
        CREATE TYPE "AppPlatformEnum" AS ENUM ('ANDROID', 'IOS', 'WINDOWS', 'WEB');
      END IF;
    END
    $$;
  `);

  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "LauncherIconConfig" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "applicationType" "AppTypeEnum" NOT NULL,
      "platform" "AppPlatformEnum" NOT NULL,
      "defaultIconId" TEXT NOT NULL DEFAULT 'default',
      "defaultIconUrl" TEXT NOT NULL,
      "seasonalIconId" TEXT,
      "seasonalIconUrl" TEXT,
      "seasonalEnabled" BOOLEAN NOT NULL DEFAULT false,
      "campaignName" TEXT,
      "campaignDeepLink" TEXT,
      "campaignStartAt" TIMESTAMP(3) WITH TIME ZONE,
      "campaignEndAt" TIMESTAMP(3) WITH TIME ZONE,
      "timezone" TEXT NOT NULL DEFAULT 'Asia/Aden',
      "publishedVersion" INTEGER NOT NULL DEFAULT 1,
      "updatedAt" TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedBy" TEXT,
      CONSTRAINT "LauncherIconConfig_app_platform_unique" UNIQUE ("applicationType", "platform")
    );
  `);

  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS "LauncherIconConfig_app_platform_idx" ON "LauncherIconConfig"("applicationType", "platform");
  `);
  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS "LauncherIconConfig_seasonalEnabled_idx" ON "LauncherIconConfig"("seasonalEnabled");
  `);

  console.log('[LauncherConfig] Table and indexes verified successfully.');

  // Seed default 4 independent configurations if not already present
  const seedConfigs = [
    {
      applicationType: 'CUSTOMER' as const,
      platform: 'ANDROID' as const,
      defaultIconId: 'default',
      defaultIconUrl: '/uploads/branding/souqnaa-app-icon.png',
      seasonalIconId: 'sale_1_1',
      seasonalIconUrl: '',
      seasonalEnabled: false,
      campaignName: '',
      campaignDeepLink: 'souqnaa-customer://campaign',
      timezone: 'Asia/Aden',
      publishedVersion: 1,
    },
    {
      applicationType: 'CUSTOMER' as const,
      platform: 'IOS' as const,
      defaultIconId: 'default',
      defaultIconUrl: '/uploads/branding/souqnaa-app-icon.png',
      seasonalIconId: 'sale_1_1',
      seasonalIconUrl: '',
      seasonalEnabled: false,
      campaignName: '',
      campaignDeepLink: 'souqnaa-customer://campaign',
      timezone: 'Asia/Aden',
      publishedVersion: 1,
    },
    {
      applicationType: 'SELLER' as const,
      platform: 'ANDROID' as const,
      defaultIconId: 'seller_default',
      defaultIconUrl: '/uploads/branding/seller_app_icon.png',
      seasonalIconId: 'seller_sale_1_1',
      seasonalIconUrl: '',
      seasonalEnabled: false,
      campaignName: '',
      campaignDeepLink: 'souqnaa-seller://campaign',
      timezone: 'Asia/Aden',
      publishedVersion: 1,
    },
    {
      applicationType: 'SELLER' as const,
      platform: 'IOS' as const,
      defaultIconId: 'seller_default',
      defaultIconUrl: '/uploads/branding/seller_app_icon.png',
      seasonalIconId: 'seller_sale_1_1',
      seasonalIconUrl: '',
      seasonalEnabled: false,
      campaignName: '',
      campaignDeepLink: 'souqnaa-seller://campaign',
      timezone: 'Asia/Aden',
      publishedVersion: 1,
    },
  ];

  for (const c of seedConfigs) {
    const existing = await prisma.$queryRawUnsafe<any[]>(
      `SELECT "id" FROM "LauncherIconConfig" WHERE "applicationType" = $1::"AppTypeEnum" AND "platform" = $2::"AppPlatformEnum" LIMIT 1`,
      c.applicationType,
      c.platform
    );

    if (!existing || existing.length === 0) {
      await prisma.$executeRawUnsafe(
        `INSERT INTO "LauncherIconConfig" (
          "id", "applicationType", "platform", "defaultIconId", "defaultIconUrl",
          "seasonalIconId", "seasonalIconUrl", "seasonalEnabled", "campaignName",
          "campaignDeepLink", "timezone", "publishedVersion", "updatedAt"
        ) VALUES (
          gen_random_uuid(), $1::"AppTypeEnum", $2::"AppPlatformEnum", $3, $4,
          $5, $6, $7, $8, $9, $10, $11, CURRENT_TIMESTAMP
        )`,
        c.applicationType,
        c.platform,
        c.defaultIconId,
        c.defaultIconUrl,
        c.seasonalIconId,
        c.seasonalIconUrl,
        c.seasonalEnabled,
        c.campaignName,
        c.campaignDeepLink,
        c.timezone,
        c.publishedVersion
      );
      console.log(`[LauncherConfig] Seeded initial config for ${c.applicationType}_${c.platform}`);
    } else if (c.applicationType === 'SELLER') {
      // Ensure SELLER configurations never retain customer 'default' icon identifier
      await prisma.$executeRawUnsafe(
        `UPDATE "LauncherIconConfig" 
         SET "defaultIconId" = $1, "defaultIconUrl" = $2, "updatedAt" = CURRENT_TIMESTAMP
         WHERE "applicationType" = 'SELLER'::"AppTypeEnum" AND "platform" = $3::"AppPlatformEnum" AND ("defaultIconId" = 'default' OR "defaultIconId" IS NULL)`,
        c.defaultIconId,
        c.defaultIconUrl,
        c.platform
      );
    }
  }

  console.log('[LauncherConfig] All 4 independent launcher configurations ready.');
}

if (require.main === module) {
  initLauncherConfigsTable()
    .then(() => {
      console.log('Done.');
      process.exit(0);
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
