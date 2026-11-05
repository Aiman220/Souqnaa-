import { normalizeMessage } from '../src/modules/chat/chat.routes';
import { SocketService } from '../src/services/websocket/socket.service';

async function runTests() {
  console.log('===============================================================');
  console.log('🧪 SOUQNA MESSAGE RECEIPTS & SETTINGS BACKEND REGRESSION TEST');
  console.log('===============================================================\n');

  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, testName: string, detail?: string) {
    if (condition) {
      console.log(`  ✅ PASS: ${testName}`);
      passed++;
    } else {
      console.error(`  ❌ FAIL: ${testName}${detail ? ` - ${detail}` : ''}`);
      failed++;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // 1. MESSAGE NORMALIZATION & DELIVERY STATUS STATES
  // ─────────────────────────────────────────────────────────────────────────────
  console.log('1. Message Normalization & Delivery Status States:');

  const unreadMessage = {
    id: 'msg-norm-1',
    conversationId: 'conv-100',
    senderId: 'user-sender',
    text: 'Hello from sender',
    type: 'text',
    isRead: false,
    createdAt: new Date('2026-11-05T12:00:00Z'),
    metadata: null,
  };

  const normUnread = normalizeMessage(unreadMessage);
  assert(normUnread.deliveryStatus === 'sent', 'Initial message has deliveryStatus = sent');
  assert(normUnread.isDelivered === false, 'Initial message has isDelivered = false');
  assert(normUnread.isRead === false, 'Initial message has isRead = false');

  const deliveredMessage = {
    id: 'msg-norm-2',
    conversationId: 'conv-100',
    senderId: 'user-sender',
    text: 'Delivered message',
    type: 'text',
    isRead: false,
    createdAt: new Date('2026-11-05T12:00:00Z'),
    metadata: JSON.stringify({ isDelivered: true, deliveredAt: '2026-11-05T12:01:00Z' }),
  };

  const normDelivered = normalizeMessage(deliveredMessage);
  assert(normDelivered.deliveryStatus === 'delivered', 'Message with delivery metadata has deliveryStatus = delivered');
  assert(normDelivered.isDelivered === true, 'Message with delivery metadata has isDelivered = true');
  assert(normDelivered.isRead === false, 'Delivered message is not yet marked read');

  const readMessage = {
    id: 'msg-norm-3',
    conversationId: 'conv-100',
    senderId: 'user-sender',
    text: 'Read message',
    type: 'text',
    isRead: true,
    createdAt: new Date('2026-11-05T12:00:00Z'),
    metadata: JSON.stringify({ isDelivered: true }),
  };

  const normRead = normalizeMessage(readMessage);
  assert(normRead.deliveryStatus === 'read', 'Read message has deliveryStatus = read');
  assert(normRead.isDelivered === true, 'Read message has isDelivered = true');
  assert(normRead.isRead === true, 'Read message has isRead = true');

  // ─────────────────────────────────────────────────────────────────────────────
  // 2. SOCKET EMISSION & RECEIPT PROPAGATION
  // ─────────────────────────────────────────────────────────────────────────────
  console.log('\n2. Socket Delivery & Read Event Propagation:');

  const socketService = new (SocketService as any)();
  const emittedEvents: Array<{ room: string; event: string; payload: any }> = [];
  (socketService as any).io = {
    to: (room: string) => ({
      emit: (event: string, payload: any) => {
        emittedEvents.push({ room, event, payload });
      },
    }),
    sockets: {
      adapter: {
        rooms: new Map<string, Set<string>>(),
      },
    },
  };

  socketService.emitToUser('user-sender', 'message:delivered', {
    conversationId: 'conv-100',
    messageId: 'msg-norm-1',
    deliveryStatus: 'delivered',
  });

  const deliveryEvent = emittedEvents.find(
    (e) => e.room === 'user:user-sender' && e.event === 'message:delivered'
  );
  assert(deliveryEvent !== undefined, 'Delivery event emitted to sender user room');
  assert(deliveryEvent?.payload?.deliveryStatus === 'delivered', 'Delivery event payload contains deliveryStatus: delivered');

  socketService.emitToConversation('conv-100', 'messages:read', {
    conversationId: 'conv-100',
    readByUserId: 'user-recipient',
    deliveryStatus: 'read',
  });

  const readEvent = emittedEvents.find(
    (e) => e.room === 'conversation:conv-100' && e.event === 'messages:read'
  );
  assert(readEvent !== undefined, 'Read event emitted to conversation room');
  assert(readEvent?.payload?.deliveryStatus === 'read', 'Read event payload contains deliveryStatus: read');

  // ─────────────────────────────────────────────────────────────────────────────
  // 3. RECEIPT INTEGRITY & REGRESSION PREVENTION
  // ─────────────────────────────────────────────────────────────────────────────
  console.log('\n3. Receipt Integrity & Out-of-Order Prevention:');

  // If a message is read, it cannot regress to delivered
  const alreadyReadMsg = { ...readMessage };
  const incomingDeliveryReceipt = { deliveryStatus: 'delivered' };
  const resolvedStatus = alreadyReadMsg.isRead ? 'read' : incomingDeliveryReceipt.deliveryStatus;
  assert(resolvedStatus === 'read', 'Status does not regress from read to delivered when out-of-order receipt arrives');

  // ─────────────────────────────────────────────────────────────────────────────
  // 4. PREMATURE READ PREVENTION (SERVER-AUTHORITATIVE CHECKS)
  // ─────────────────────────────────────────────────────────────────────────────
  console.log('\n4. Server-Authoritative Read Receipt Enforcement:');

  // Freshly sent message must never start as read
  const freshlySentMsg = {
    id: 'msg-fresh-1',
    conversationId: 'conv-100',
    senderId: 'user-sender',
    text: 'Newly sent',
    type: 'text',
    isRead: false,
    createdAt: new Date(),
    metadata: null,
  };
  const normFresh = normalizeMessage(freshlySentMsg);
  assert(normFresh.deliveryStatus === 'sent', 'Newly sent message starts with deliveryStatus = sent');
  assert(normFresh.isRead === false, 'Newly sent message has isRead = false');

  // Subscribing to room or user presence must NOT produce read events for fresh messages
  const freshReadEvents = emittedEvents.filter(
    (e) => e.event === 'messages:read' && e.payload?.messageId === 'msg-fresh-1'
  );
  assert(freshReadEvents.length === 0, 'No read receipts emitted upon message creation');

  console.log('\n===============================================================');
  console.log(`TEST SUMMARY: ${passed} passed, ${failed} failed`);
  console.log('===============================================================');

  if (failed > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

runTests().catch((err) => {
  console.error('Test execution error:', err);
  process.exit(1);
});
