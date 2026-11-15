import { prisma } from '../src/database/prisma';

async function run() {
  const settings = await prisma.systemSetting.findMany({
    where: {
      key: {
        in: [
          'app_branding_config',
          'seller_branding_config',
          'customer_app_icon',
          'seller_app_icon',
          'remote_config_version',
        ],
      },
    },
  });
  console.log('--- SystemSettings ---');
  for (const s of settings) {
    console.log(`Key: ${s.key}, UpdatedAt: ${s.updatedAt}`);
    try {
      console.log('Value:', JSON.stringify(JSON.parse(s.value), null, 2));
    } catch {
      console.log('Value:', s.value);
    }
  }

  console.log('--- LauncherIconConfigs ---');
  const configs = await prisma.launcherIconConfig.findMany();
  console.log(JSON.stringify(configs, null, 2));
}

run()
  .catch((e) => {
    console.error(e);
  })
  .finally(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
