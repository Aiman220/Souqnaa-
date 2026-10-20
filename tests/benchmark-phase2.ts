import http from 'http';
import { createApp } from '../src/app';
import { redis } from '../src/database/redis';

async function runBenchmark() {
  const app = createApp();
  const server = http.createServer(app);

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const address = server.address() as any;
  const port = address.port;
  const baseUrl = `http://127.0.0.1:${port}`;
  console.log(`[Benchmark Server] Listening on ${baseUrl}`);

  // Invalidate cache first
  await redis.del('cache:home:feed');

  // Helper request
  function request(path: string, headers: Record<string, string> = {}): Promise<{ status: number; headers: http.IncomingHttpHeaders; durationMs: number; sizeBytes: number; data: any }> {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const req = http.request(`${baseUrl}${path}`, { headers }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const durationMs = Date.now() - start;
          const buf = Buffer.concat(chunks);
          let data: any = null;
          try {
            data = JSON.parse(buf.toString('utf8'));
          } catch (_) {}
          resolve({
            status: res.statusCode || 0,
            headers: res.headers,
            durationMs,
            sizeBytes: buf.length,
            data,
          });
        });
      });
      req.on('error', reject);
      req.end();
    });
  }

  try {
    console.log('\n===============================================================');
    console.log('🏁 SOUQNA PHASE 2 VERIFICATION & PERFORMANCE BENCHMARK');
    console.log('===============================================================');

    console.log('\n--- 1. Testing /api/v1/home Cache & Latency ---');
    // First call (Cold cache)
    const t1 = await request('/api/v1/home');
    console.log(`Run 1 (Cold Cache - Remote DB Queries): status=${t1.status}, duration=${t1.durationMs}ms, payloadSize=${t1.sizeBytes} bytes, success=${t1.data?.success}`);

    // Second call (Warm cache from L1/L2)
    const t2 = await request('/api/v1/home');
    console.log(`Run 2 (Warm Cache - L1 Memory / L2 Redis): status=${t2.status}, duration=${t2.durationMs}ms, payloadSize=${t2.sizeBytes} bytes, success=${t2.data?.success}`);

    // Third call (Warm cache)
    const t3 = await request('/api/v1/home');
    console.log(`Run 3 (Warm Cache - L1 Memory / L2 Redis): status=${t3.status}, duration=${t3.durationMs}ms, payloadSize=${t3.sizeBytes} bytes, success=${t3.data?.success}`);

    console.log('\n--- 2. Testing Gzip / Deflate Compression Middleware ---');
    const gzipRes = await request('/api/v1/home', { 'Accept-Encoding': 'gzip' });
    console.log(`Gzip Response: status=${gzipRes.status}, encoding=${gzipRes.headers['content-encoding']}, compressedSize=${gzipRes.sizeBytes} bytes, uncompressedSize=${t1.sizeBytes} bytes`);
    if (t1.sizeBytes > 0 && gzipRes.sizeBytes > 0) {
      const compressionRatio = ((1 - gzipRes.sizeBytes / t1.sizeBytes) * 100).toFixed(1);
      console.log(`Compression Savings: ${compressionRatio}% bandwidth reduction`);
    }

    console.log('\n--- 3. Testing Selective Cache-Control Headers ---');
    const catRes = await request('/api/v1/categories');
    console.log(`Public catalog /api/v1/categories Cache-Control: "${catRes.headers['cache-control']}"`);

    const orderRes = await request('/api/v1/orders/me');
    console.log(`Private route /api/v1/orders/me Cache-Control: "${orderRes.headers['cache-control']}"`);

    console.log('\n===============================================================');
    console.log('🏁 BENCHMARK COMPLETE');
    console.log('===============================================================');
  } finally {
    server.close();
    process.exit(0);
  }
}

runBenchmark().catch((err) => {
  console.error('[Benchmark Error]', err);
  process.exit(1);
});
