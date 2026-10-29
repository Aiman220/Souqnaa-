import http from 'http';
import { io as Client } from 'socket.io-client';
import { SocketService } from '../src/services/websocket/socket.service';
import { JwtUtil } from '../src/utils/jwt.util';
import { prisma } from '../src/database/prisma';
import { SupportService } from '../src/modules/support/support.service';
import { SupportRequesterType, SupportPriority } from '@prisma/client';

async function runRemediationVerificationSuite() {
  console.log('========================================================================');
  console.log('🚀 SOUQNA COMPREHENSIVE PRODUCTION CHAT & SUPPORT END-TO-END REMEDIATION');
  console.log('========================================================================\n');

  const server = http.createServer();
  SocketService.init(server);

  const PORT = 54401;
  await new Promise<void>((resolve) => server.listen(PORT, resolve));
  console.log(`[Suite] Local test server listening on port ${PORT}`);

  // Fetch or resolve valid test users
  const customerUser = await prisma.user.findFirst({
    where: { role: 'CUSTOMER' },
    select: { id: true, email: true },
  });
  const sellerUser = await prisma.user.findFirst({
    where: { role: 'SELLER' },
    select: { id: true, email: true },
  });
  let adminUser = await prisma.user.findFirst({
    where: { role: 'ADMIN' },
    select: { id: true, email: true },
  });

  if (!customerUser || !sellerUser) {
    throw new Error('Test requires at least one customer and one seller in database');
  }

  if (!adminUser) {
    adminUser = await prisma.user.create({
      data: {
        email: 'test_admin_remediation@souqna.online',
        passwordHash: 'hash',
        role: 'ADMIN',
        firstName: 'Test',
        lastName: 'Admin',
      },
      select: { id: true, email: true },
    });
  }

  console.log(`[Suite] Customer: ${customerUser.id} (${customerUser.email})`);
  console.log(`[Suite] Seller:   ${sellerUser.id} (${sellerUser.email})`);
  console.log(`[Suite] Admin:    ${adminUser.id} (${adminUser.email})`);

  // Ensure conversation between Customer and Seller
  let conversation = await prisma.conversation.findFirst({
    where: {
      type: 'direct',
      AND: [
        { members: { some: { userId: customerUser.id } } },
        { members: { some: { userId: sellerUser.id } } },
      ],
    },
  });

  if (!conversation) {
    conversation = await prisma.conversation.create({
      data: {
        type: 'direct',
        members: {
          create: [
            { userId: customerUser.id },
            { userId: sellerUser.id },
          ],
        },
      },
    });
  }

  const convId = conversation.id;
  console.log(`[Suite] Direct Conversation ID: ${convId}\n`);

  // Generate valid JWT tokens
  const customerToken = JwtUtil.generateTokens({
    userId: customerUser.id,
    email: customerUser.email,
    role: 'CUSTOMER' as any,
  }).accessToken;

  const sellerToken = JwtUtil.generateTokens({
    userId: sellerUser.id,
    email: sellerUser.email,
    role: 'SELLER' as any,
  }).accessToken;

  const adminToken = JwtUtil.generateTokens({
    userId: adminUser.id,
    email: adminUser.email,
    role: 'ADMIN' as any,
  }).accessToken;

  // --------------------------------------------------------------------------
  // FLOW 1: Customer <-> Seller Direct Real-Time Socket Messaging & Typing
  // --------------------------------------------------------------------------
  console.log('--- TEST 1: Customer <-> Seller Socket Handshake & Room Authorization ---');
  let customerClient = Client(`http://localhost:${PORT}`, {
    auth: { token: customerToken },
    transports: ['websocket'],
  });
  const sellerClient = Client(`http://localhost:${PORT}`, {
    auth: { token: sellerToken },
    transports: ['websocket'],
  });

  await Promise.all([
    new Promise<void>((resolve, reject) => {
      customerClient.on('connect', () => {
        console.log('  ✔ Customer socket authenticated and connected');
        resolve();
      });
      customerClient.on('connect_error', reject);
    }),
    new Promise<void>((resolve, reject) => {
      sellerClient.on('connect', () => {
        console.log('  ✔ Seller socket authenticated and connected');
        resolve();
      });
      sellerClient.on('connect_error', reject);
    }),
  ]);

  // Join authorized rooms with ack
  await Promise.all([
    new Promise<void>((resolve, reject) => {
      customerClient.emit('join:conversation', convId, (ack: any) => {
        if (ack?.success) {
          console.log('  ✔ Customer authorized and joined room:', convId);
          resolve();
        } else reject(new Error('Customer join rejected: ' + JSON.stringify(ack)));
      });
    }),
    new Promise<void>((resolve, reject) => {
      sellerClient.emit('join:conversation', convId, (ack: any) => {
        if (ack?.success) {
          console.log('  ✔ Seller authorized and joined room:', convId);
          resolve();
        } else reject(new Error('Seller join rejected: ' + JSON.stringify(ack)));
      });
    }),
  ]);

  console.log('\n--- TEST 2: Bidirectional Typing Indicators (Customer <-> Seller) ---');
  // Customer types -> Seller receives
  const sellerReceivedTypingPromise = new Promise<void>((resolve) => {
    sellerClient.once('typing:start', (data) => {
      console.log('  ✔ Seller received typing:start from Customer:', data.userId);
      resolve();
    });
  });
  customerClient.emit('typing:start', { conversationId: convId });
  await sellerReceivedTypingPromise;

  // Seller types -> Customer receives
  const customerReceivedTypingPromise = new Promise<void>((resolve) => {
    customerClient.once('typing:start', (data) => {
      console.log('  ✔ Customer received typing:start from Seller:', data.userId);
      resolve();
    });
  });
  sellerClient.emit('typing:start', { conversationId: convId });
  await customerReceivedTypingPromise;

  console.log('\n--- TEST 3: Bidirectional Real-Time Messages (Customer <-> Seller) ---');
  // Customer sends message -> Seller receives
  const sellerMessagePromise = new Promise<any>((resolve) => {
    sellerClient.once('message:new', (msg) => {
      console.log('  ✔ Seller received live message from Customer:', msg.content || msg.text);
      resolve(msg);
    });
  });
  customerClient.emit('message:send', {
    conversationId: convId,
    content: 'Hello Seller! Remediation test 101.',
    text: 'Hello Seller! Remediation test 101.',
    type: 'text',
  }, (ack: any) => {
    if (ack?.error) console.error('  ❌ message:send ack error:', ack.error);
    else console.log('  ✔ Customer send ack received');
  });
  const receivedBySeller = await sellerMessagePromise;
  if (!receivedBySeller) throw new Error('Seller did not receive message');

  // Seller sends reply -> Customer receives
  const customerMessagePromise = new Promise<any>((resolve) => {
    customerClient.once('message:new', (msg) => {
      console.log('  ✔ Customer received live reply from Seller:', msg.content || msg.text);
      resolve(msg);
    });
  });
  sellerClient.emit('message:send', {
    conversationId: convId,
    content: 'Hello Customer! Reply test 102.',
    text: 'Hello Customer! Reply test 102.',
    type: 'text',
  }, (ack: any) => {
    if (ack?.error) console.error('  ❌ message:send ack error:', ack.error);
    else console.log('  ✔ Seller send ack received');
  });
  const receivedByCustomer = await customerMessagePromise;
  if (!receivedByCustomer) throw new Error('Customer did not receive reply');

  // Read receipts: Seller marks seen -> Customer receives read receipt
  const readReceiptPromise = new Promise<void>((resolve) => {
    customerClient.once('messages:read', (data) => {
      console.log('  ✔ Customer received read receipt acknowledgment');
      resolve();
    });
  });
  sellerClient.emit('message:seen', { conversationId: convId });
  await readReceiptPromise;

  // --------------------------------------------------------------------------
  // FLOW 2: Support Ticket Lifecycle & Real-Time Support Messaging
  // --------------------------------------------------------------------------
  console.log('\n--- TEST 4: Support Conversation Creation & Admin Queue ---');
  const supConv = await SupportService.createConversation({
    requesterType: SupportRequesterType.CUSTOMER,
    requesterId: customerUser.id,
    subject: 'Critical Chat Remediation Verification',
    priority: SupportPriority.HIGH,
    initialMessage: 'Initial support question from customer',
  });

  const supportConvId = supConv.conversationId || supConv.id;
  const supportTicketNum = supConv.ticket?.ticketNumber || 'SUP-TICKET';
  console.log(`  ✔ Support ticket created: ${supportTicketNum} (Conv: ${supportConvId})`);

  // Connect Admin Socket
  const adminClient = Client(`http://localhost:${PORT}`, {
    auth: { token: adminToken },
    transports: ['websocket'],
  });

  await new Promise<void>((resolve, reject) => {
    adminClient.on('connect', () => {
      console.log('  ✔ Admin socket authenticated and connected');
      resolve();
    });
    adminClient.on('connect_error', reject);
  });

  // Admin enters support queue
  adminClient.emit('join:support_queue');

  // Customer joins support conversation room
  await new Promise<void>((resolve, reject) => {
    customerClient.emit('join:conversation', supportConvId, (ack: any) => {
      if (ack?.success) {
        console.log('  ✔ Customer joined support conversation room');
        resolve();
      } else reject(new Error('Customer failed to join support room: ' + JSON.stringify(ack)));
    });
  });

  // Admin joins support room -> auto-claims ticket and notifies Customer
  const assignmentPromise = new Promise<any>((resolve) => {
    customerClient.once('support:conversation:assigned', (data) => {
      console.log('  ✔ Customer received live support agent assignment:', data.agent?.displayName);
      resolve(data);
    });
  });

  await new Promise<void>((resolve, reject) => {
    adminClient.emit('join:conversation', supportConvId, (ack: any) => {
      if (ack?.success) {
        console.log('  ✔ Admin joined support room and claimed ticket');
        resolve();
      } else reject(new Error('Admin failed to join support room: ' + JSON.stringify(ack)));
    });
  });
  await assignmentPromise;

  console.log('\n--- TEST 5: Bidirectional Support Messaging & Live Typing ---');
  // Admin types in support -> Customer receives typing indicator
  const customerSupportTypingPromise = new Promise<void>((resolve) => {
    customerClient.once('typing:start', (data) => {
      console.log('  ✔ Customer received typing:start from Support Agent');
      resolve();
    });
  });
  adminClient.emit('support:typing:start', { conversationId: supportConvId });
  await customerSupportTypingPromise;

  // Customer types in support -> Admin receives typing indicator
  const adminSupportTypingPromise = new Promise<void>((resolve) => {
    adminClient.once('typing:start', (data) => {
      console.log('  ✔ Support Agent received typing:start from Customer');
      resolve();
    });
  });
  customerClient.emit('support:typing:start', { conversationId: supportConvId });
  await adminSupportTypingPromise;

  // Support Agent sends reply via SupportService -> Customer receives in real time
  const customerReceivedSupportMsgPromise = new Promise<any>((resolve) => {
    customerClient.once('message:new', (msg) => {
      console.log('  ✔ Customer received support reply in real time:', msg.content || msg.text);
      resolve(msg);
    });
  });
  await SupportService.sendMessage(
    supportConvId,
    adminUser.id,
    'ADMIN',
    'We are resolving your issue immediately!',
  );
  await customerReceivedSupportMsgPromise;

  // Customer replies to Support via SupportService -> Admin receives in real time
  const adminReceivedCustomerMsgPromise = new Promise<any>((resolve) => {
    adminClient.once('message:new', (msg) => {
      console.log('  ✔ Support Agent received customer message in real time:', msg.content || msg.text);
      resolve(msg);
    });
  });
  await SupportService.sendMessage(
    supportConvId,
    customerUser.id,
    'CUSTOMER',
    'Thank you for the quick support response!',
  );
  await adminReceivedCustomerMsgPromise;

  // --------------------------------------------------------------------------
  // FLOW 3: Automatic Reconnection & Subscription Recovery
  // --------------------------------------------------------------------------
  console.log('\n--- TEST 6: Automatic Reconnection & Room Recovery ---');
  // Disconnect customer
  customerClient.disconnect();
  console.log('  ✔ Customer socket disconnected (simulating network transition)');

  // Reconnect customer socket with fresh token
  customerClient = Client(`http://localhost:${PORT}`, {
    auth: { token: customerToken },
    transports: ['websocket'],
  });

  await new Promise<void>((resolve, reject) => {
    customerClient.on('connect', () => {
      console.log('  ✔ Customer reconnected successfully');
      resolve();
    });
    customerClient.on('connect_error', reject);
  });

  // Re-subscribe to support conversation
  await new Promise<void>((resolve, reject) => {
    customerClient.emit('join:conversation', supportConvId, (ack: any) => {
      if (ack?.success) {
        console.log('  ✔ Customer recovered support room subscription');
        resolve();
      } else reject(new Error('Customer recovery join failed: ' + JSON.stringify(ack)));
    });
  });

  // Send message from Admin -> Customer receives immediately after reconnection
  const postReconnectMsgPromise = new Promise<any>((resolve) => {
    customerClient.once('message:new', (msg) => {
      console.log('  ✔ Reconnected customer received real-time message:', msg.content || msg.text);
      resolve(msg);
    });
  });
  await SupportService.sendMessage(
    supportConvId,
    adminUser.id,
    'ADMIN',
    'Testing recovery: message delivered after client reconnect!',
  );
  await postReconnectMsgPromise;

  // Clean up
  customerClient.disconnect();
  sellerClient.disconnect();
  adminClient.disconnect();
  server.close();

  console.log('\n========================================================================');
  console.log('🎉 ALL REMEDIATION INTEGRATION FLOWS VERIFIED SUCCESSFULLY (6/6)');
  console.log('========================================================================\n');
}

runRemediationVerificationSuite()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('❌ Remediation Suite Failed:', err);
    process.exit(1);
  });
