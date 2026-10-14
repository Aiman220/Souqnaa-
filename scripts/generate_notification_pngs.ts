import sharp from 'sharp';
import fs from 'fs';
import path from 'path';

const svgBuffer = Buffer.from(`
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="96" height="96">
    <path fill="#FFFFFF" d="M19,6h-2c0,-2.76 -2.24,-5 -5,-5S7,3.24 7,6H5C3.9,6 3,6.9 3,8v12c0,1.1 0.9,2 2,2h14c1.1,0 2,-0.9 2,-2V8C21,6.9 20.1,6 19,6zM12,3c1.66,0 3,1.34 3,3H9C9,4.34 10.34,3 12,3zM19,20H5V8h14V20zM12,10c-1.66,0 -3,1.34 -3,3s1.34,3 3,3 3,-1.34 3,-3S13.66,10 12,10z"/>
</svg>
`);

const densities = [
  { folder: 'drawable-mdpi', size: 24 },
  { folder: 'drawable-hdpi', size: 36 },
  { folder: 'drawable-xhdpi', size: 48 },
  { folder: 'drawable-xxhdpi', size: 72 },
  { folder: 'drawable-xxxhdpi', size: 96 },
];

const targetApps = [
  path.resolve(__dirname, '../../apps/customer/android/app/src/main/res'),
  path.resolve(__dirname, '../../apps/seller/android/app/src/main/res'),
];

async function generatePngs() {
  console.log('Generating Android monochrome PNG notification icons...');

  for (const appResDir of targetApps) {
    for (const density of densities) {
      const targetDir = path.join(appResDir, density.folder);
      if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
      }

      const targetPath = path.join(targetDir, 'ic_notification.png');
      await sharp(svgBuffer)
        .resize(density.size, density.size)
        .png()
        .toFile(targetPath);

      console.log(`Generated: ${targetPath} (${density.size}x${density.size})`);
    }
  }

  console.log('All PNG notification icons generated successfully!');
}

generatePngs().catch(console.error);
