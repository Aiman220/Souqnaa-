import sharp from 'sharp';

export interface VisualFeatureVector {
  dHash: string; // 64-bit hex hash of 8x8 difference
  dHash256?: string; // 256-bit hex hash of 16x16 difference
  avgR: number;
  avgG: number;
  avgB: number;
  brightness: number; // 0-255
  dominantColor: string;
  aspectRatio: number;
  // Foreground object stats (excluding white/transparent background)
  fgAvgR: number;
  fgAvgG: number;
  fgAvgB: number;
  fgBrightness: number;
  fgRatio: number; // percentage of image occupied by object
}

export interface ImageValidationResult {
  isValid: boolean;
  format?: 'jpeg' | 'png' | 'webp';
  width?: number;
  height?: number;
  error?: string;
}

/**
 * Validates actual image buffer content using magic numbers (header signatures)
 * to prevent MIME spoofing, malformed files, or decompression bombs.
 */
export function validateImageBuffer(buffer: Buffer, maxBytes: number = 10 * 1024 * 1024): ImageValidationResult {
  if (!buffer || buffer.length === 0) {
    return { isValid: false, error: 'Empty image buffer received' };
  }

  if (buffer.length > maxBytes) {
    return { isValid: false, error: `Image size exceeds maximum limit of ${Math.round(maxBytes / (1024 * 1024))}MB` };
  }

  // Check magic numbers:
  // JPEG: FF D8 FF
  if (buffer.length >= 3 && buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) {
    return { isValid: true, format: 'jpeg' };
  }

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4E &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0D &&
    buffer[5] === 0x0A &&
    buffer[6] === 0x1A &&
    buffer[7] === 0x0A
  ) {
    return { isValid: true, format: 'png' };
  }

  // WebP: 52 49 46 46 ... 57 45 42 50 ("RIFF" ... "WEBP")
  if (
    buffer.length >= 12 &&
    buffer[0] === 0x52 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x46 &&
    buffer[8] === 0x57 &&
    buffer[9] === 0x45 &&
    buffer[10] === 0x42 &&
    buffer[11] === 0x50
  ) {
    return { isValid: true, format: 'webp' };
  }

  return {
    isValid: false,
    error: 'Unsupported or corrupted image format. Please upload JPEG, PNG, or WebP.',
  };
}

/**
 * Extracts perceptual difference hashes and multi-level color profiles from an image buffer.
 * - Validates file magic bytes
 * - Auto-orients image based on EXIF tag and strips all GPS/camera EXIF metadata
 * - Normalizes alpha transparency onto a clean pure white background
 * - Computes multi-resolution difference hashes (64-bit and 256-bit)
 * - Computes foreground object color segmentation
 */
export async function extractVisualFeatures(buffer: Buffer): Promise<VisualFeatureVector> {
  try {
    const validation = validateImageBuffer(buffer);
    if (!validation.isValid) {
      throw new Error(validation.error || 'Invalid image buffer');
    }

    const sampleSize = 64;

    // Concurrent direct raw buffer extraction using Sharp with fastShrinkOnLoad:
    // - 9x8 grayscale raw buffer (72 bytes) for standard 64-bit dHash
    // - 17x16 grayscale raw buffer (272 bytes) for 256-bit HD dHash
    // - 64x64 raw RGB buffer (12,288 bytes) for color metrics & foreground segmentation
    // - metadata for original aspect ratio
    // This eliminates intermediate 1024x1024 PNG/JPEG encoding and removes 5 redundant decoding passes.
    const [dHashPixels, dHash256Pixels, rawRgb, metadata] = await Promise.all([
      sharp(buffer, { failOn: 'none' })
        .rotate()
        .resize(9, 8, { fit: 'fill', fastShrinkOnLoad: true })
        .grayscale()
        .raw()
        .toBuffer(),
      sharp(buffer, { failOn: 'none' })
        .rotate()
        .resize(17, 16, { fit: 'fill', fastShrinkOnLoad: true })
        .grayscale()
        .raw()
        .toBuffer(),
      sharp(buffer, { failOn: 'none' })
        .rotate()
        .resize(sampleSize, sampleSize, { fit: 'fill', fastShrinkOnLoad: true })
        .flatten({ background: { r: 255, g: 255, b: 255 } })
        .removeAlpha()
        .raw()
        .toBuffer(),
      sharp(buffer, { failOn: 'none' }).metadata(),
    ]);

    const width = metadata.width || 100;
    const height = metadata.height || 100;
    const aspectRatio = width / Math.max(height, 1);

    // 1. Grayscale 9x8 for standard 64-bit difference hash (dHash)
    let hashBinary = '';
    for (let row = 0; row < 8; row++) {
      const rowOffset = row * 9;
      for (let col = 0; col < 8; col++) {
        const left = dHashPixels[rowOffset + col];
        const right = dHashPixels[rowOffset + col + 1];
        hashBinary += left < right ? '1' : '0';
      }
    }
    const dHash = BigInt('0b' + hashBinary).toString(16).padStart(16, '0');

    // 2. Grayscale 17x16 for 256-bit high-definition difference hash (dHash256)
    let hash256Hex = '';
    for (let part = 0; part < 4; part++) {
      let partBinary = '';
      for (let i = part * 64; i < (part + 1) * 64; i++) {
        const row = Math.floor(i / 16);
        const col = i % 16;
        const left = dHash256Pixels[row * 17 + col];
        const right = dHash256Pixels[row * 17 + col + 1];
        partBinary += left < right ? '1' : '0';
      }
      hash256Hex += BigInt('0b' + partBinary).toString(16).padStart(16, '0');
    }

    // 3. Ultra-fast single-pass color statistics & foreground segmentation (4,096 samples)
    const totalPixels = sampleSize * sampleSize;
    let sumR = 0;
    let sumG = 0;
    let sumB = 0;
    let fgCount = 0;
    let fgSumR = 0;
    let fgSumG = 0;
    let fgSumB = 0;

    for (let i = 0; i < totalPixels; i++) {
      const idx = i * 3;
      const r = rawRgb[idx];
      const g = rawRgb[idx + 1];
      const b = rawRgb[idx + 2];

      sumR += r;
      sumG += g;
      sumB += b;

      // Exclude near-white background pixels (R, G, B all > 240)
      if (r < 242 || g < 242 || b < 242) {
        fgCount++;
        fgSumR += r;
        fgSumG += g;
        fgSumB += b;
      }
    }

    const avgR = Math.round(sumR / totalPixels);
    const avgG = Math.round(sumG / totalPixels);
    const avgB = Math.round(sumB / totalPixels);
    const brightness = Math.round((avgR * 299 + avgG * 587 + avgB * 114) / 1000);

    const fgRatio = fgCount / totalPixels;
    const fgAvgR = fgCount > 0 ? Math.round(fgSumR / fgCount) : avgR;
    const fgAvgG = fgCount > 0 ? Math.round(fgSumG / fgCount) : avgG;
    const fgAvgB = fgCount > 0 ? Math.round(fgSumB / fgCount) : avgB;
    const fgBrightness = Math.round((fgAvgR * 299 + fgAvgG * 587 + fgAvgB * 114) / 1000);

    // 4. Dominant color category (based on foreground object if exists, else overall)
    const targetR = fgRatio > 0.05 ? fgAvgR : avgR;
    const targetG = fgRatio > 0.05 ? fgAvgG : avgG;
    const targetB = fgRatio > 0.05 ? fgAvgB : avgB;
    const targetBrightness = fgRatio > 0.05 ? fgBrightness : brightness;

    let dominantColor = 'other';
    if (targetBrightness < 65) {
      dominantColor = 'black_dark';
    } else if (targetBrightness > 210 && fgRatio <= 0.1) {
      dominantColor = 'white_light';
    } else if (targetR > 130 && targetG > 100 && targetB < 85) {
      dominantColor = 'gold_yellow';
    } else if (targetB > targetR + 20 && targetB > targetG + 20) {
      dominantColor = 'blue';
    } else if (targetG > targetR + 20 && targetG > targetB + 20) {
      dominantColor = 'green';
    } else if (targetR > targetG + 30 && targetR > targetB + 30) {
      dominantColor = 'red';
    } else if (targetR > 90 && targetG > 55 && targetB < 50) {
      dominantColor = 'brown';
    } else {
      dominantColor = 'neutral';
    }

    return {
      dHash,
      dHash256: hash256Hex,
      avgR,
      avgG,
      avgB,
      brightness,
      dominantColor,
      aspectRatio,
      fgAvgR,
      fgAvgG,
      fgAvgB,
      fgBrightness,
      fgRatio,
    };
  } catch (err) {
    // Fallback if image buffer cannot be decoded
    return {
      dHash: '0000000000000000',
      dHash256: '0'.repeat(64),
      avgR: 128,
      avgG: 128,
      avgB: 128,
      brightness: 128,
      dominantColor: 'other',
      aspectRatio: 1.0,
      fgAvgR: 128,
      fgAvgG: 128,
      fgAvgB: 128,
      fgBrightness: 128,
      fgRatio: 0.5,
    };
  }
}

/**
 * Fast 32-bit integer popcount (number of set bits).
 * Runs directly in CPU registers without BigInt heap overhead.
 */
function popcount32(x: number): number {
  x = (x | 0) - (((x | 0) >>> 1) & 0x55555555);
  x = ((x & 0x33333333) + ((x >>> 2) & 0x33333333)) | 0;
  return ((((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24);
}

/**
 * Calculates the Hamming distance between two 64-bit dHashes.
 * Lower distance means higher visual similarity (0 = identical).
 * Uses native 32-bit bitwise operations for maximum throughput.
 */
export function calculateHammingDistance(hash1: string, hash2: string): number {
  if (!hash1 || !hash2) return 64;
  if (hash1 === hash2) return 0;

  try {
    const h1 = hash1.padStart(16, '0');
    const h2 = hash2.padStart(16, '0');

    const high1 = parseInt(h1.substring(0, 8), 16) | 0;
    const low1 = parseInt(h1.substring(8, 16), 16) | 0;
    const high2 = parseInt(h2.substring(0, 8), 16) | 0;
    const low2 = parseInt(h2.substring(8, 16), 16) | 0;

    return popcount32((high1 ^ high2) >>> 0) + popcount32((low1 ^ low2) >>> 0);
  } catch {
    return 64;
  }
}

/**
 * Calculates Hamming distance for arbitrary length hex hashes (e.g. 256-bit).
 * Processes 32-bit (8-hex-character) slices with native bitwise popcount.
 */
export function calculateHammingDistanceHex(hash1: string, hash2: string): number {
  if (!hash1 || !hash2) return 256;
  if (hash1 === hash2) return 0;

  try {
    const len = Math.min(hash1.length, hash2.length);
    let dist = 0;
    for (let i = 0; i < len; i += 8) {
      const v1 = parseInt(hash1.substring(i, i + 8), 16) | 0;
      const v2 = parseInt(hash2.substring(i, i + 8), 16) | 0;
      dist += popcount32((v1 ^ v2) >>> 0);
    }
    if (hash1.length !== hash2.length) {
      dist += Math.abs(hash1.length - hash2.length) * 4;
    }
    return dist;
  } catch {
    return 256;
  }
}

/**
 * Computes color distance (Euclidean in RGB space).
 * Range 0 - 441.6
 */
export function calculateColorDistance(
  c1: { avgR: number; avgG: number; avgB: number },
  c2: { avgR: number; avgG: number; avgB: number }
): number {
  const dr = c1.avgR - c2.avgR;
  const dg = c1.avgG - c2.avgG;
  const db = c1.avgB - c2.avgB;
  return Math.sqrt(dr * dr + dg * dg + db * db);
}
