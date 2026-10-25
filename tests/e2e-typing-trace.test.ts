import http from 'http';
import { io as Client } from 'socket.io-client';
import { SocketService } from '../src/services/websocket/socket.service';
import { JwtUtil } from '../src/utils/jwt.util';
import { prisma } from '../src/database/prisma';

async function runE2ETest() {
  console.log('===============================================================');
  console.log('🧪 SOUQNA END-TO-END TYPING INDICATOR REAL SOCKET TRACE');
  console.log('===============================================================\n');

  // 1. Create HTTP server and initialize SocketService
  const server = http.createServer();
  SocketService.init(server);

  const PORT = 54399;
  await new Promise<void>((resolve) => server.listen(PORT, resolve));
  console.log(`[E2E] Server listening on port ${PORT}`);

  const convId = '7aa7cd48-deca-4d04-a8c5-97b61e5b8bc4';
  const customerUserId = '5fc8ab5a-31a4-47ec-9003-7c89c7da659f';
  const sellerUserId = 'a7626a27-ebf3-4fa9-b729-f73b97d96736';

  const customerTokens = JwtUtil.generateTokens({
    userId: customerUserId,
    email: 'dearoftime@gmail.com',
    role: 'CUSTOMER' as any,
  });

  const sellerTokens = JwtUtil.generateTokens({
    userId: sellerUserId,
    email: 'selle11@souqna.online',
    role: 'SELLER' as any,
  });

  // 2. Connect Customer client
  const customerClient = Client(`http://localhost:${PORT}`, {
    auth: { token: customerTokens.accessToken },
    transports: ['websocket'],
  });

  // 3. Connect Seller client
  const sellerClient = Client(`http://localhost:${PORT}`, {
    auth: { token: sellerTokens.accessToken },
    transports: ['websocket'],
  });

  await Promise.all([
    new Promise<void>((resolve, reject) => {
      customerClient.on('connect', () => {
        console.log('[E2E] Customer client connected to Socket.IO');
        resolve();
      });
      customerClient.on('connect_error', reject);
    }),
    new Promise<void>((resolve, reject) => {
      sellerClient.on('connect', () => {
        console.log('[E2E] Seller client connected to Socket.IO');
        resolve();
      });
      sellerClient.on('connect_error', reject);
    }),
  ]);

  // 4. Join conversation room on both clients
  console.log('[E2E] Joining conversation room on both clients...');
  const customerJoinAck = await new Promise<any>((resolve) => {
    customerClient.emit('join:conversation', convId, resolve);
  });
  console.log('[E2E] Customer join ack:', customerJoinAck);

  const sellerJoinAck = await new Promise<any>((resolve) => {
    sellerClient.emit('join:conversation', convId, resolve);
  });
  console.log('[E2E] Seller join ack:', sellerJoinAck);

  // 5. Test Direction 1: Customer Types -> Seller Receives
  console.log('\n--- Testing Direction 1: Customer -> Seller ---');
  let sellerReceivedTypingStart = false;
  let sellerReceivedStartPayload: any = null;

  sellerClient.on('typing:start', (payload) => {
    console.log('[E2E] Seller received typing:start event:', payload);
    sellerReceivedTypingStart = true;
    sellerReceivedStartPayload = payload;
  });

  sellerClient.on('typing:status', (payload) => {
    console.log('[E2E] Seller received typing:status event:', payload);
  });

  console.log('[E2E] Emitting typing:start from Customer...');
  customerClient.emit('typing:start', { conversationId: convId, id: convId, isTyping: true });

  await new Promise((r) => setTimeout(r, 1000));

  console.log(`[E2E] Seller received typing:start? ${sellerReceivedTypingStart}`);
  if (!sellerReceivedTypingStart) {
    console.error('❌ Checkpoint E FAILED: Seller did NOT receive typing:start from Customer!');
  } else {
    console.log('✅ Checkpoint E PASSED: Seller received typing:start with payload:', sellerReceivedStartPayload);
  }

  // 6. Test Direction 1 Stop: Customer stops typing
  console.log('\n[E2E] Emitting typing:stop from Customer...');
  let sellerReceivedTypingStop = false;
  sellerClient.on('typing:stop', (payload) => {
    console.log('[E2E] Seller received typing:stop event:', payload);
    sellerReceivedTypingStop = true;
  });

  customerClient.emit('typing:stop', { conversationId: convId, id: convId, isTyping: false });
  await new Promise((r) => setTimeout(r, 1000));
  console.log(`[E2E] Seller received typing:stop? ${sellerReceivedTypingStop}`);

  // 7. Test Direction 2: Seller Types -> Customer Receives
  console.log('\n--- Testing Direction 2: Seller -> Customer ---');
  let customerReceivedTypingStart = false;
  let customerReceivedStartPayload: any = null;

  customerClient.on('typing:start', (payload) => {
    console.log('[E2E] Customer received typing:start event:', payload);
    customerReceivedTypingStart = true;
    customerReceivedStartPayload = payload;
  });

  customerClient.on('typing:status', (payload) => {
    console.log('[E2E] Customer received typing:status event:', payload);
  });

  console.log('[E2E] Emitting typing:start from Seller...');
  sellerClient.emit('typing:start', { conversationId: convId, id: convId, isTyping: true });

  await new Promise((r) => setTimeout(r, 1000));

  console.log(`[E2E] Customer received typing:start? ${customerReceivedTypingStart}`);
  if (!customerReceivedTypingStart) {
    console.error('❌ Checkpoint E FAILED: Customer did NOT receive typing:start from Seller!');
  } else {
    console.log('✅ Checkpoint E PASSED: Customer received typing:start with payload:', customerReceivedStartPayload);
  }

  // 8. Test Direction 2 Stop: Seller stops typing
  console.log('\n[E2E] Emitting typing:stop from Seller...');
  let customerReceivedTypingStop = false;
  customerClient.on('typing:stop', (payload) => {
    console.log('[E2E] Customer received typing:stop event:', payload);
    customerReceivedTypingStop = true;
  });

  sellerClient.emit('typing:stop', { conversationId: convId, id: convId, isTyping: false });
  await new Promise((r) => setTimeout(r, 1000));
  console.log(`[E2E] Customer received typing:stop? ${customerReceivedTypingStop}`);

  // Clean up
  customerClient.disconnect();
  sellerClient.disconnect();
  server.close();
  await prisma.$disconnect();

  const allPassed = sellerReceivedTypingStart && sellerReceivedTypingStop && customerReceivedTypingStart && customerReceivedTypingStop;
  console.log('\n===============================================================');
  console.log(`E2E TRACE RESULT: ${allPassed ? 'ALL PASSED' : 'FAILURES DETECTED'}`);
  console.log('===============================================================');
  process.exit(allPassed ? 0 : 1);
}

runE2ETest().catch((err) => {
  console.error('E2E Test Error:', err);
  process.exit(1);
});
