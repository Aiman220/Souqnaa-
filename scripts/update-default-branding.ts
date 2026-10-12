import { prisma } from '../src/database/prisma';
import { DEFAULT_APP_BRANDING } from '../src/modules/remote-config/feature-flags.defaults';
import { remoteConfigService } from '../src/modules/remote-config/remote-config.service';

async function updateDefaultBranding() {
  console.log('Applying new default Souqnaa icon across all platforms...');
  
  await prisma.systemSetting.upsert({
    where: { key: 'app_branding_config' },
    create: {
      key: 'app_branding_config',
      value: JSON.stringify(DEFAULT_APP_BRANDING),
      type: 'json',
      group: 'remote_config',
    },
    update: {
      value: JSON.stringify(DEFAULT_APP_BRANDING),
    },
  });

  remoteConfigService.invalidateCache();
  console.log('✓ Successfully updated database app_branding_config to new default app icon!');
  
  const branding = await remoteConfigService.getBrandingConfig();
  console.log('Default icon URL:', branding.defaultIconUrl);
  console.log('Android icon URL:', branding.platforms.android.iconUrl);
  console.log('iOS icon URL:', branding.platforms.ios.iconUrl);
  console.log('Tablet icon URL:', branding.platforms.tablet.iconUrl);
  console.log('Desktop icon URL:', branding.platforms.desktop.iconUrl);
  console.log('Web icon URL:', branding.platforms.web.iconUrl);

  await prisma.$disconnect();
}

updateDefaultBranding();
