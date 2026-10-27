import { prisma } from '../../../database/prisma';
import {
  DomainNotificationEvent,
  RenderedNotificationContent,
  NotificationCategory,
} from '../notification.types';

interface TemplateDefinition {
  titleAr: string;
  titleEn: string;
  bodyAr: string;
  bodyEn: string;
  deepLinkPattern?: string;
}

export class NotificationTemplateService {
  private static instance: NotificationTemplateService;
  private dbTemplateCache = new Map<string, { definition: TemplateDefinition; cachedAt: number }>();
  private CACHE_TTL_MS = 60 * 1000; // 1 minute

  private defaultTemplates: Record<string, TemplateDefinition> = {
    // ── Orders (Customer) ──────────────────────────────────────────────────
    ORDER_CREATED: {
      titleAr: 'تم استلام طلبك بنجاح 🎉',
      titleEn: 'Order received successfully 🎉',
      bodyAr: 'طلبك رقم #{{orderNumber}} قيد المراجعة الآن.',
      bodyEn: 'Your order #{{orderNumber}} is being reviewed.',
      deepLinkPattern: 'souqnaa://orders/{{orderId}}',
    },
    ORDER_ACCEPTED: {
      titleAr: 'تم قبول طلبك من المتجر 🛍️',
      titleEn: 'Your order was accepted 🛍️',
      bodyAr: 'بدأ المتجر بتجهيز طلبك رقم #{{orderNumber}}.',
      bodyEn: 'The store started preparing your order #{{orderNumber}}.',
      deepLinkPattern: 'souqnaa://orders/{{orderId}}',
    },
    ORDER_CONFIRMED: {
      titleAr: 'تم تأكيد طلبك 📦',
      titleEn: 'Order confirmed 📦',
      bodyAr: 'طلبك رقم #{{orderNumber}} مؤكد وجاري التحضير.',
      bodyEn: 'Your order #{{orderNumber}} is confirmed and in prep.',
      deepLinkPattern: 'souqnaa://orders/{{orderId}}',
    },
    ORDER_PROCESSING: {
      titleAr: 'جاري تجهيز طلبك ⏳',
      titleEn: 'Order is being processed ⏳',
      bodyAr: 'طلبك رقم #{{orderNumber}} قيد التجهيز للتسليم لمندوب التوصيل.',
      bodyEn: 'Your order #{{orderNumber}} is being packed for delivery.',
      deepLinkPattern: 'souqnaa://orders/{{orderId}}',
    },
    ORDER_READY_TO_SHIP: {
      titleAr: 'طلبك جاهز للشحن 🚚',
      titleEn: 'Order is ready to ship 🚚',
      bodyAr: 'تم تجهيز طلبك رقم #{{orderNumber}} بانتظار استلام المندوب.',
      bodyEn: 'Order #{{orderNumber}} is ready for courier pickup.',
      deepLinkPattern: 'souqnaa://orders/{{orderId}}',
    },
    ORDER_SHIPPED: {
      titleAr: 'تم شحن طلبك 🚀',
      titleEn: 'Your order has shipped 🚀',
      bodyAr: 'طلبك رقم #{{orderNumber}} في طريقه إليك {{carrierName}}.',
      bodyEn: 'Order #{{orderNumber}} has shipped with {{carrierName}}.',
      deepLinkPattern: 'souqnaa://orders/{{orderId}}',
    },
    ORDER_OUT_FOR_DELIVERY: {
      titleAr: 'المندوب في طريقه إليك 🛵',
      titleEn: 'Out for delivery 🛵',
      bodyAr: 'طلبك رقم #{{orderNumber}} مع مندوب التوصيل الآن وسيصلك قريباً.',
      bodyEn: 'Courier is delivering your order #{{orderNumber}} soon.',
      deepLinkPattern: 'souqnaa://orders/{{orderId}}',
    },
    ORDER_DELIVERED: {
      titleAr: 'تم تسليم طلبك بنجاح ✅',
      titleEn: 'Order delivered successfully ✅',
      bodyAr: 'نتمنى أن تنال مشترياتك في الطلب #{{orderNumber}} إعجابك! شاركنا تقييمك.',
      bodyEn: 'Hope you enjoy order #{{orderNumber}}! Leave a review.',
      deepLinkPattern: 'souqnaa://orders/{{orderId}}',
    },
    ORDER_CANCELLED: {
      titleAr: 'تم إلغاء الطلب ❌',
      titleEn: 'Order cancelled ❌',
      bodyAr: 'تم إلغاء الطلب رقم #{{orderNumber}}. السبب: {{cancelReason}}',
      bodyEn: 'Order #{{orderNumber}} was cancelled. Reason: {{cancelReason}}',
      deepLinkPattern: 'souqnaa://orders/{{orderId}}',
    },
    SELLER_CANCELLATION_REQUESTED: {
      titleAr: 'طلب إلغاء من العميل ⚠️',
      titleEn: 'Customer Cancellation Request ⚠️',
      bodyAr: 'طلب العميل إلغاء الطلب #{{orderNumber}}. السبب: {{cancelReason}}',
      bodyEn: 'Customer requested cancellation for order #{{orderNumber}}. Reason: {{cancelReason}}',
      deepLinkPattern: 'souqnaa://seller/orders/{{orderId}}',
    },
    SELLER_ORDER_CANCELLED: {
      titleAr: 'تم إلغاء الطلب',
      titleEn: 'Order cancelled',
      bodyAr: 'تم إلغاء الطلب رقم #{{orderNumber}}. السبب: {{cancelReason}}',
      bodyEn: 'Order #{{orderNumber}} was cancelled. Reason: {{cancelReason}}',
      deepLinkPattern: 'souqnaa://seller/orders/{{orderId}}',
    },

    // ── Payments ────────────────────────────────────────────────────────────
    PAYMENT_PENDING: {
      titleAr: 'عملية الدفع معلقة ⏳',
      titleEn: 'Payment pending ⏳',
      bodyAr: 'بانتظار تأكيد سداد {{amount}} {{currency}} للطلب #{{orderNumber}}.',
      bodyEn: 'Awaiting payment confirmation for {{amount}} {{currency}} on #{{orderNumber}}.',
      deepLinkPattern: 'souqnaa://orders/{{orderId}}',
    },
    PAYMENT_SUCCESS: {
      titleAr: 'تم الدفع بنجاح 💳',
      titleEn: 'Payment successful 💳',
      bodyAr: 'تم استلام مبلغ {{amount}} {{currency}} بنجاح للطلب #{{orderNumber}}.',
      bodyEn: 'Payment of {{amount}} {{currency}} received for #{{orderNumber}}.',
      deepLinkPattern: 'souqnaa://orders/{{orderId}}',
    },
    PAYMENT_FAILED: {
      titleAr: 'فشلت عملية الدفع ⚠️',
      titleEn: 'Payment failed ⚠️',
      bodyAr: 'تعذر إتمام الدفع للطلب #{{orderNumber}}. يرجى المحاولة بطريقة أخرى.',
      bodyEn: 'Payment failed for order #{{orderNumber}}. Please retry.',
      deepLinkPattern: 'souqnaa://orders/{{orderId}}',
    },
    PAYMENT_EXPIRED: {
      titleAr: 'انتهت صلاحية جلسة الدفع ⏱️',
      titleEn: 'Payment session expired ⏱️',
      bodyAr: 'انتهت مهلة الدفع للطلب #{{orderNumber}}. يمكنك إعادة تقديم الطلب.',
      bodyEn: 'Payment session expired for #{{orderNumber}}.',
      deepLinkPattern: 'souqnaa://orders/{{orderId}}',
    },

    // ── Refunds ─────────────────────────────────────────────────────────────
    REFUND_REQUESTED: {
      titleAr: 'تم استلام طلب الاسترجاع 🔄',
      titleEn: 'Refund request received 🔄',
      bodyAr: 'طلب الاسترجاع رقم {{refundNumber}} قيد المراجعة من المتجر.',
      bodyEn: 'Refund request {{refundNumber}} is under review.',
      deepLinkPattern: 'souqnaa://refunds/{{refundId}}',
    },
    REFUND_ACCEPTED: {
      titleAr: 'تمت الموافقة على الاسترجاع ✓',
      titleEn: 'Refund approved ✓',
      bodyAr: 'وافق المتجر على استرجاع {{amount}} {{currency}} لطلبك.',
      bodyEn: 'Store approved your refund of {{amount}} {{currency}}.',
      deepLinkPattern: 'souqnaa://refunds/{{refundId}}',
    },
    REFUND_REJECTED: {
      titleAr: 'تم رفض طلب الاسترجاع ❌',
      titleEn: 'Refund rejected ❌',
      bodyAr: 'رفض المتجر طلب الاسترجاع {{refundNumber}}. يمكنك رفع نزاع للإدارة.',
      bodyEn: 'Store rejected refund {{refundNumber}}. You can dispute.',
      deepLinkPattern: 'souqnaa://refunds/{{refundId}}',
    },
    REFUND_ESCALATED: {
      titleAr: 'تم تصعيد النزاع للإدارة ⚖️',
      titleEn: 'Dispute escalated ⚖️',
      bodyAr: 'يقوم فريق وساطة سوقناا بمراجعة النزاع رقم {{refundNumber}} وسنوافيك بالقرار.',
      bodyEn: 'SOUQNAA team is reviewing dispute {{refundNumber}}.',
      deepLinkPattern: 'souqnaa://refunds/{{refundId}}',
    },
    REFUND_COMPLETED: {
      titleAr: 'تم تحويل مبلغ الاسترجاع 💰',
      titleEn: 'Refund completed 💰',
      bodyAr: 'تم إيداع {{amount}} {{currency}} في محفظتك بنجاح.',
      bodyEn: '{{amount}} {{currency}} has been credited to your wallet.',
      deepLinkPattern: 'souqnaa://wallet',
    },

    // ── Universal Disputes ──────────────────────────────────────────────────
    DISPUTE_CREATED: {
      titleAr: 'تم تسجيل النزاع بنجاح ⚖️',
      titleEn: 'Dispute submitted successfully ⚖️',
      bodyAr: 'تم تسجيل نزاعك على الطلب #{{orderNumber}} بنجاح وهو قيد التحكيم لدى المنصة.',
      bodyEn: 'Your dispute for order #{{orderNumber}} has been submitted and is under arbitration.',
      deepLinkPattern: 'souqnaa://disputes/{{disputeId}}',
    },
    DISPUTE_SELLER_NOTIFIED: {
      titleAr: 'نزاع جديد يتطلب ردك ⚠️',
      titleEn: 'New dispute requires your response ⚠️',
      bodyAr: 'فتح العميل نزاعاً على الطلب #{{orderNumber}}. يرجى مراجعة التفاصيل والرد خلال 48 ساعة.',
      bodyEn: 'Customer opened a dispute on order #{{orderNumber}}. Please review and respond within 48 hours.',
      deepLinkPattern: 'souqnaa://seller/refunds/{{disputeId}}',
    },
    DISPUTE_SELLER_RESPONDED: {
      titleAr: 'رد المتجر على النزاع 📝',
      titleEn: 'Seller responded to dispute 📝',
      bodyAr: 'قدم المتجر رده بخصوص النزاع على الطلب #{{orderNumber}} وجارٍ مراجعته.',
      bodyEn: 'Seller submitted a response regarding the dispute for order #{{orderNumber}}.',
      deepLinkPattern: 'souqnaa://disputes/{{disputeId}}',
    },
    DISPUTE_EVIDENCE_SUBMITTED: {
      titleAr: 'تم تقديم أدلة جديدة في النزاع 📎',
      titleEn: 'New evidence submitted 📎',
      bodyAr: 'تم إرفاق مستندات أو صور إضافية بخصوص النزاع على الطلب #{{orderNumber}}.',
      bodyEn: 'New evidence has been attached to the dispute for order #{{orderNumber}}.',
      deepLinkPattern: 'souqnaa://disputes/{{disputeId}}',
    },
    DISPUTE_INFO_REQUESTED: {
      titleAr: 'طلب معلومات إضافية للنزاع ℹ️',
      titleEn: 'Additional information requested ℹ️',
      bodyAr: 'طلبت إدارة المنصة توضيحات إضافية حول النزاع: {{note}}',
      bodyEn: 'Platform administration requested additional info regarding the dispute: {{note}}',
      deepLinkPattern: 'souqnaa://disputes/{{disputeId}}',
    },
    DISPUTE_ESCALATED: {
      titleAr: 'تم تصعيد النزاع للإدارة 🚨',
      titleEn: 'Dispute escalated to admin 🚨',
      bodyAr: 'تم تصعيد النزاع للتحكيم الإداري النهائي على الطلب #{{orderNumber}}.',
      bodyEn: 'Dispute for order #{{orderNumber}} has been escalated to senior arbitration.',
      deepLinkPattern: 'souqnaa://disputes/{{disputeId}}',
    },
    DISPUTE_RESOLVED: {
      titleAr: 'تم البت في النزاع للطلب #{{orderNumber}} ⚖️',
      titleEn: 'Dispute decision issued for order #{{orderNumber}} ⚖️',
      bodyAr: 'أصدرت الإدارة قرارها النهائي للطلب #{{orderNumber}}: {{resolution}}',
      bodyEn: 'Dispute decision for order #{{orderNumber}} has been finalized: {{resolution}}',
      deepLinkPattern: 'souqnaa://disputes/{{disputeId}}',
    },
    DISPUTE_APPEALED: {
      titleAr: 'تم تقديم طلب استئناف على النزاع 🔄',
      titleEn: 'Dispute decision appealed 🔄',
      bodyAr: 'تم تسجيل طلب استئناف بخصوص قرار النزاع على الطلب #{{orderNumber}}.',
      bodyEn: 'An appeal has been submitted for the dispute on order #{{orderNumber}}.',
      deepLinkPattern: 'souqnaa://disputes/{{disputeId}}',
    },
    DISPUTE_DEADLINE_APPROACHING: {
      titleAr: 'تذكير: اقتراب الموعد النهائي للرد ⏳',
      titleEn: 'Deadline approaching for dispute response ⏳',
      bodyAr: 'يرجى تقديم ردك على النزاع للطلب #{{orderNumber}} قبل انتهاء المهلة المحددة.',
      bodyEn: 'Please submit your response to dispute for order #{{orderNumber}} before deadline.',
      deepLinkPattern: 'souqnaa://disputes/{{disputeId}}',
    },
    // ── Wallet ──────────────────────────────────────────────────────────────
    WALLET_CREDITED: {
      titleAr: 'تم شحن المحفظة 💰',
      titleEn: 'Wallet credited 💰',
      bodyAr: 'تمت إضافة {{amount}} {{currency}} إلى رصيد محفظتك.',
      bodyEn: '{{amount}} {{currency}} added to your wallet.',
      deepLinkPattern: 'souqnaa://wallet',
    },
    WALLET_DEBITED: {
      titleAr: 'خصم من المحفظة 💸',
      titleEn: 'Wallet debited 💸',
      bodyAr: 'تم خصم {{amount}} {{currency}} من محفظتك.',
      bodyEn: '{{amount}} {{currency}} debited from your wallet.',
      deepLinkPattern: 'souqnaa://wallet',
    },
    WALLET_TRANSFER_COMPLETED: {
      titleAr: 'اكتمل التحويل بنجاح ✅',
      titleEn: 'Transfer completed ✅',
      bodyAr: 'تمت معالجة حوالتك المالية بمبلغ {{amount}} {{currency}}.',
      bodyEn: 'Your transfer of {{amount}} {{currency}} is completed.',
      deepLinkPattern: 'souqnaa://wallet',
    },
    WALLET_TRANSFER_FAILED: {
      titleAr: 'تعذر إتمام التحويل ⚠️',
      titleEn: 'Transfer failed ⚠️',
      bodyAr: 'فشلت عملية التحويل المالي بمبلغ {{amount}} {{currency}}.',
      bodyEn: 'Transfer of {{amount}} {{currency}} failed.',
      deepLinkPattern: 'souqnaa://wallet',
    },

    // ── Coins & Rewards ─────────────────────────────────────────────────────
    COINS_EARNED: {
      titleAr: 'حصلت على عملات سوقناا! 🪙',
      titleEn: 'Coins earned! 🪙',
      bodyAr: 'مبروك! كسبت {{coinsAmount}} عملة من برنامج مكافآت سوقناا.',
      bodyEn: 'Congrats! You earned {{coinsAmount}} SOUQNAA coins.',
      deepLinkPattern: 'souqnaa://rewards',
    },
    COINS_REDEEMED: {
      titleAr: 'تم استبدال العملات بنجاح 🎁',
      titleEn: 'Coins redeemed 🎁',
      bodyAr: 'تم استخدام {{coinsAmount}} عملة للحصول على خصم في طلبك.',
      bodyEn: 'Redeemed {{coinsAmount}} coins on your order.',
      deepLinkPattern: 'souqnaa://rewards',
    },
    COINS_EXPIRING: {
      titleAr: 'عملاتك ستنتهي صلاحيتها قريباً ⏰',
      titleEn: 'Coins expiring soon ⏰',
      bodyAr: 'لديك عملات تنتهي خلال {{expiryDays}} أيام. استبدلها بخصومات الآن!',
      bodyEn: 'Coins expiring in {{expiryDays}} days. Redeem now!',
      deepLinkPattern: 'souqnaa://rewards',
    },
    COINS_EXPIRED: {
      titleAr: 'انتهت صلاحية بعض العملات ⌛',
      titleEn: 'Coins expired ⌛',
      bodyAr: 'انتهت صلاحية العملات غير المستخدمة في حساب المكافآت.',
      bodyEn: 'Unused coins have expired.',
      deepLinkPattern: 'souqnaa://rewards',
    },
    REWARD_COMPLETED: {
      titleAr: 'أنجزت مهمة بنجاح! 🏆',
      titleEn: 'Mission completed! 🏆',
      bodyAr: 'أكملت مهمة "{{missionTitle}}" واستحققت المكافأة.',
      bodyEn: 'Completed mission "{{missionTitle}}".',
      deepLinkPattern: 'souqnaa://rewards',
    },

    // ── Coupons ─────────────────────────────────────────────────────────────
    COUPON_AVAILABLE: {
      titleAr: 'كوبون خصم جديد بانتظارك! 🎟️',
      titleEn: 'New coupon available! 🎟️',
      bodyAr: 'استخدم الكود {{couponCode}} للحصول على خصم {{discountValue}}.',
      bodyEn: 'Use code {{couponCode}} for {{discountValue}} off.',
      deepLinkPattern: 'souqnaa://coupons/{{couponId}}',
    },
    COUPON_EXPIRING: {
      titleAr: 'كوبون الخصم ينتهي قريباً ⏳',
      titleEn: 'Coupon expiring soon ⏳',
      bodyAr: 'كوبون {{couponCode}} بخصم {{discountValue}} ينتهي قريباً، لا تفوت الفرصة!',
      bodyEn: 'Coupon {{couponCode}} expiring soon, don\'t miss out!',
      deepLinkPattern: 'souqnaa://coupons/{{couponId}}',
    },
    COUPON_USED: {
      titleAr: 'تم تفعيل الكوبون بنجاح 🎉',
      titleEn: 'Coupon applied 🎉',
      bodyAr: 'تم تطبيق الكوبون {{couponCode}} وحصلت على خصم {{discountValue}}.',
      bodyEn: 'Coupon {{couponCode}} applied with discount {{discountValue}}.',
      deepLinkPattern: 'souqnaa://coupons/{{couponId}}',
    },

    // ── Flash Sales & Mega Campaigns ────────────────────────────────────────
    FLASH_SALE_STARTED: {
      titleAr: 'انطلقت عروض الفلاش سيل! ⚡',
      titleEn: 'Flash Sale is live! ⚡',
      bodyAr: 'تخفيضات هائلة لفترة محدودة تبدأ الآن، تسوق قبل نفاد الكمية!',
      bodyEn: 'Huge limited-time discounts start now, grab them fast!',
      deepLinkPattern: 'souqnaa://flash-sales',
    },
    FLASH_SALE_ENDING: {
      titleAr: 'عروض الفلاش سيل تنتهي قريباً! ⏱️',
      titleEn: 'Flash Sale ending soon! ⏱️',
      bodyAr: 'ساعات قليلة متبقية على انتهاء أقوى التخفيضات في سوقناا.',
      bodyEn: 'Only a few hours left on SOUQNAA flash sale!',
      deepLinkPattern: 'souqnaa://flash-sales',
    },
    FLASH_SALE_ENDED: {
      titleAr: 'انتهت عروض الفلاش سيل 🔚',
      titleEn: 'Flash Sale ended 🔚',
      bodyAr: 'انتظروا العروض القادمة قريباً مع تخفيضات جديدة ومفاجآت حصرية.',
      bodyEn: 'Stay tuned for our next flash sale surprises.',
      deepLinkPattern: 'souqnaa://flash-sales',
    },
    MEGA_CAMPAIGN_STARTED: {
      titleAr: 'مهرجان التخفيضات الكبرى بدأ! 🎪',
      titleEn: 'Mega Campaign is live! 🎪',
      bodyAr: '{{campaignTitleAr}} انطلقت الآن! خصومات استثنائية تصل إلى {{discountPercentage}}%.',
      bodyEn: '{{campaignTitleEn}} is live now! Up to {{discountPercentage}}% off.',
      deepLinkPattern: 'souqnaa://campaigns/{{campaignId}}',
    },
    BROADCAST_CAMPAIGN: {
      titleAr: 'تخفيضات وعروض خاصة 🌟',
      titleEn: 'Special Offers 🌟',
      bodyAr: 'عروض حصرية لجميع عملاء سوقناا تبدأ الآن!',
      bodyEn: 'Exclusive offers starting now!',
      deepLinkPattern: 'souqnaa://home',
    },

    // ── Price Drop & Stock Alerts ───────────────────────────────────────────
    PRICE_DROPPED: {
      titleAr: 'انخفض سعر منتج في قائمتك! 📉',
      titleEn: 'Price dropped on your item! 📉',
      bodyAr: 'انخفض سعر {{productNameAr}} من {{oldPrice}} إلى {{newPrice}}!',
      bodyEn: '{{productNameEn}} dropped from {{oldPrice}} to {{newPrice}}!',
      deepLinkPattern: 'souqnaa://products/{{productId}}',
    },
    BACK_IN_STOCK: {
      titleAr: 'عادت الكمية للمنتج! 🔔',
      titleEn: 'Back in stock! 🔔',
      bodyAr: 'المنتج {{productNameAr}} أصبح متوفراً الآن، اطلبه قبل النفاد.',
      bodyEn: '{{productNameEn}} is back in stock, order now!',
      deepLinkPattern: 'souqnaa://products/{{productId}}',
    },
    LOW_STOCK: {
      titleAr: 'الكمية قاربت على النفاد! ⚠️',
      titleEn: 'Low stock alert! ⚠️',
      bodyAr: 'المنتج {{productNameAr}} بقي منه قطع معدودة فقط.',
      bodyEn: 'Only a few items left of {{productNameEn}}.',
      deepLinkPattern: 'souqnaa://products/{{productId}}',
    },

    // ── Chat ────────────────────────────────────────────────────────────────
    CHAT_MESSAGE_RECEIVED: {
      titleAr: 'رسالة جديدة من {{senderName}} 💬',
      titleEn: 'New message from {{senderName}} 💬',
      bodyAr: '{{messageText}}',
      bodyEn: '{{messageText}}',
      deepLinkPattern: 'souqnaa://chat/{{conversationId}}',
    },
    CHAT_MENTION: {
      titleAr: 'تمت الإشارة إليك من {{senderName}} 📢',
      titleEn: 'Mentioned by {{senderName}} 📢',
      bodyAr: 'أشار إليك {{senderName}} في محادثة: {{messageText}}',
      bodyEn: '{{senderName}} mentioned you: {{messageText}}',
      deepLinkPattern: 'souqnaa://chat/{{conversationId}}',
    },

    // ── Seller Notifications ────────────────────────────────────────────────
    SELLER_NEW_ORDER: {
      titleAr: 'طلب جديد وارد لمتاجرك! 🛍️',
      titleEn: 'New order received! 🛍️',
      bodyAr: 'لديك طلب جديد رقم #{{orderNumber}} بقيمة {{totalAmount}} YER.',
      bodyEn: 'You have a new order #{{orderNumber}} worth {{totalAmount}} YER.',
      deepLinkPattern: 'souqnaa://seller/orders/{{orderId}}',
    },
    SELLER_ORDER_RECEIVED: {
      titleAr: 'أكد العميل استلام الطلب',
      titleEn: 'Customer confirmed order received',
      bodyAr: 'أكد العميل استلام الطلب رقم #{{orderNumber}}. افتح سوقنا لعرض تفاصيل الطلب.',
      bodyEn: 'The customer confirmed receipt of order #{{orderNumber}}. Open SOUQNA to view the order.',
      deepLinkPattern: 'souqnaa://seller/orders/{{orderId}}',
    },
    SELLER_PAYMENT_RECEIVED: {
      titleAr: 'تم تحصيل دفعة مبيعات 💵',
      titleEn: 'Payment received 💵',
      bodyAr: 'تم تحصيل دفعة الطلب #{{orderNumber}} لحسابك.',
      bodyEn: 'Payment received for order #{{orderNumber}}.',
      deepLinkPattern: 'souqnaa://seller/wallet',
    },
    SELLER_REFUND_REQUEST: {
      titleAr: 'طلب استرجاع جديد من عميل 🔄',
      titleEn: 'New refund request from customer 🔄',
      bodyAr: 'طلب العميل استرجاع الطلب #{{orderNumber}}. يرجى اتخاذ القرار.',
      bodyEn: 'Customer requested refund for order #{{orderNumber}}.',
      deepLinkPattern: 'souqnaa://seller/refunds/{{refundId}}',
    },

    // ── Security & System ───────────────────────────────────────────────────
    NEW_LOGIN: {
      titleAr: 'تسجيل دخول جديد لحسابك 🔐',
      titleEn: 'New login to your account 🔐',
      bodyAr: 'تم تسجيل الدخول من جهاز جديد ({{deviceInfo}}) في {{location}}.',
      bodyEn: 'New login detected from {{deviceInfo}} in {{location}}.',
      deepLinkPattern: 'souqnaa://profile/security',
    },
    PASSWORD_CHANGED: {
      titleAr: 'تم تغيير كلمة المرور 🔒',
      titleEn: 'Password changed 🔒',
      bodyAr: 'تم تغيير كلمة مرور حسابك بنجاح. إذا لم تكن أنت، قم بتأمين حسابك فوراً.',
      bodyEn: 'Your password was changed. If not you, secure your account.',
      deepLinkPattern: 'souqnaa://profile/security',
    },
    ADMIN_ALERT: {
      titleAr: '{{titleAr}}',
      titleEn: '{{titleEn}}',
      bodyAr: '{{messageAr}}',
      bodyEn: '{{messageEn}}',
      deepLinkPattern: 'souqnaa://admin',
    },
    WALLET_TOPUP_APPROVED: {
      titleAr: 'تم تأكيد شحن الرصيد بنجاح ✓',
      titleEn: 'Wallet Top-Up Confirmed ✓',
      bodyAr: 'تمت مراجعة حوالة الإيداع وتغذية رصيد محفظتك بمبلغ {{amount}} {{currency}} بنجاح.',
      bodyEn: 'Your deposit of {{amount}} {{currency}} has been verified and added to your balance.',
      deepLinkPattern: 'souqnaa://wallet',
    },
    WALLET_TOPUP_REJECTED: {
      titleAr: 'تعذر قبول طلب شحن الرصيد ⚠️',
      titleEn: 'Wallet Top-Up Rejected ⚠️',
      bodyAr: 'تعذر قبول طلب الشحن بمبلغ {{amount}} {{currency}}. السبب: {{reason}}',
      bodyEn: 'Your deposit request for {{amount}} {{currency}} was rejected. Reason: {{reason}}',
      deepLinkPattern: 'souqnaa://wallet',
    },
    WITHDRAWAL_COMPLETED: {
      titleAr: 'تم تنفيذ طلب السحب بنجاح 💰',
      titleEn: 'Withdrawal Completed 💰',
      bodyAr: 'تم إتمام تحويل مبلغ {{amount}} {{currency}} إلى حسابك بنجاح.',
      bodyEn: 'Withdrawal of {{amount}} {{currency}} has been completed.',
      deepLinkPattern: 'souqnaa://wallet',
    },
    WITHDRAWAL_REJECTED: {
      titleAr: 'تم رفض طلب السحب ⚠️',
      titleEn: 'Withdrawal Rejected ⚠️',
      bodyAr: 'تم رفض طلب سحب مبلغ {{amount}} {{currency}}. السبب: {{reason}}',
      bodyEn: 'Withdrawal of {{amount}} {{currency}} was rejected. Reason: {{reason}}',
      deepLinkPattern: 'souqnaa://wallet',
    },
    NEW_REVIEW_RECEIVED: {
      titleAr: 'تقييم جديد لمنتجك ⭐',
      titleEn: 'New Product Review ⭐',
      bodyAr: 'تلقى منتج "{{productName}}" تقييماً جديداً.',
      bodyEn: 'Your product "{{productName}}" received a new review.',
      deepLinkPattern: 'souqnaa://seller/reviews',
    },
    SELLER_RESPONDED_TO_REVIEW: {
      titleAr: 'ردّ البائع على تقييمك 💬',
      titleEn: 'Seller Responded to Your Review 💬',
      bodyAr: 'ردّ البائع على تقييمك لمنتج "{{productName}}".',
      bodyEn: 'The seller responded to your review for "{{productName}}".',
      deepLinkPattern: 'souqnaa://products/{{productId}}',
    },
    FLASH_SALE_SUBMISSION_APPROVED: {
      titleAr: 'تمت الموافقة على اشتراك منتجك في العرض الخاطف! 🎉',
      titleEn: 'Flash Sale Submission Approved! 🎉',
      bodyAr: 'تمت الموافقة على اشتراك منتجك "{{productName}}" في حملة "{{campaignName}}".',
      bodyEn: 'Your product "{{productName}}" has been approved for campaign "{{campaignName}}".',
      deepLinkPattern: 'souqnaa://seller/flash-sales',
    },
    FLASH_SALE_SUBMISSION_REJECTED: {
      titleAr: 'تم رفض اشتراك المنتج في العرض الخاطف ⚠️',
      titleEn: 'Flash Sale Submission Rejected ⚠️',
      bodyAr: 'تم رفض إدراج منتجك "{{productName}}" في حملة "{{campaignName}}". السبب: {{reason}}',
      bodyEn: 'Your product "{{productName}}" was rejected for campaign "{{campaignName}}". Reason: {{reason}}',
      deepLinkPattern: 'souqnaa://seller/flash-sales',
    },

    // ── Cart Abandonment Reminders ───────────────────────────────────────────
    CART_ABANDONMENT_REMINDER_1: {
      titleAr: '🛒 سلتك ما زالت بانتظارك',
      titleEn: '🛒 Your cart is waiting',
      bodyAr: 'لديك {{itemCount}} منتجات محفوظة في سلة التسوق. اضغط للعودة وإكمال طلبك.',
      bodyEn: 'You have {{itemCount}} items waiting in your cart. Tap to return and continue shopping.',
      deepLinkPattern: 'souqnaa://cart',
    },
    CART_ABANDONMENT_REMINDER_2: {
      titleAr: '⏳ لا تفوت منتجاتك في السلة',
      titleEn: '⏳ Don\'t miss the items in your cart',
      bodyAr: 'منتجاتك ما زالت محفوظة في سلتك. تابع التسوق قبل نفاد الكميات المتاحة.',
      bodyEn: 'Your items are still waiting in your cart. Complete your order before items run out.',
      deepLinkPattern: 'souqnaa://cart',
    },
    CART_ABANDONMENT_GENERIC: {
      titleAr: '🛒 سلتك ما زالت بانتظارك',
      titleEn: '🛒 Your cart is waiting',
      bodyAr: 'لديك منتجات محفوظة في سلة التسوق. اضغط للعودة وإكمال طلبك.',
      bodyEn: 'You still have products in your cart. Tap to return and continue shopping.',
      deepLinkPattern: 'souqnaa://cart',
    },
  };

  /**
   * Helper to infer category from eventType code
   */
  private inferCategory(code: string): NotificationCategory {
    if (code.startsWith('CART_ABANDONMENT_') || code.startsWith('CART_REMINDER')) return NotificationCategory.CART_ABANDONMENT;
    if (code.startsWith('ORDER_') || code.startsWith('SELLER_ORDER') || code.startsWith('SELLER_NEW_ORDER')) return NotificationCategory.ORDER;
    if (code.startsWith('PAYMENT_')) return NotificationCategory.PAYMENT;
    if (code.startsWith('REFUND_') || code.startsWith('SELLER_REFUND_') || code.startsWith('DISPUTE_')) return NotificationCategory.REFUND;
    if (code.startsWith('WALLET_') || code.startsWith('WITHDRAWAL_') || code.startsWith('SELLER_PAYMENT_')) return NotificationCategory.WALLET;
    if (code.startsWith('COIN') || code.startsWith('REWARD')) return NotificationCategory.REWARDS;
    if (code.startsWith('COUPON_')) return NotificationCategory.COUPON;
    if (code.startsWith('FLASH_SALE_')) return NotificationCategory.FLASH_SALE;
    if (code.startsWith('MEGA_CAMPAIGN_')) return NotificationCategory.MEGA_CAMPAIGN;
    if (code === 'PRICE_DROPPED') return NotificationCategory.PRICE_ALERT;
    if (code.startsWith('BACK_IN_STOCK') || code === 'LOW_STOCK') return NotificationCategory.STOCK_ALERT;
    if (code.startsWith('CHAT_')) return NotificationCategory.CHAT;
    if (code.startsWith('NEW_LOGIN') || code.startsWith('PASSWORD_') || code.startsWith('EMAIL_') || code.startsWith('PHONE_') || code.startsWith('SUSPICIOUS_') || code.startsWith('TWO_FACTOR_')) return NotificationCategory.SECURITY;
    if (code.startsWith('ADMIN_')) return NotificationCategory.ADMIN;
    if (code.includes('REVIEW')) return NotificationCategory.REVIEW;
    return NotificationCategory.SYSTEM;
  }

  /**
   * Seed all default templates into PostgreSQL database
   */
  async seedDefaultTemplates() {
    console.log('[NotificationTemplateService] Seeding default templates into DB...');
    const channelsJson = JSON.stringify(['PUSH', 'IN_APP', 'WEBSOCKET']);
    for (const [code, def] of Object.entries(this.defaultTemplates)) {
      const category = this.inferCategory(code);
      await prisma.notificationTemplate.upsert({
        where: { code },
        update: {
          category,
          titleAr: def.titleAr,
          titleEn: def.titleEn,
          bodyAr: def.bodyAr,
          bodyEn: def.bodyEn,
          deepLinkPattern: def.deepLinkPattern,
          status: 'PUBLISHED',
        },
        create: {
          code,
          category,
          titleAr: def.titleAr,
          titleEn: def.titleEn,
          bodyAr: def.bodyAr,
          bodyEn: def.bodyEn,
          defaultPriority: 'NORMAL',
          channels: channelsJson,
          deepLinkPattern: def.deepLinkPattern,
          version: 1,
          status: 'PUBLISHED',
        },
      });
    }
    console.log(`[NotificationTemplateService] Successfully seeded ${Object.keys(this.defaultTemplates).length} templates.`);
  }

  static get(): NotificationTemplateService {
    if (!NotificationTemplateService.instance) {
      NotificationTemplateService.instance = new NotificationTemplateService();
    }
    return NotificationTemplateService.instance;
  }

  /**
   * Safely interpolates {{key}} placeholders in template string with variable values.
   */
  private interpolate(templateStr: string, variables: Record<string, any>): string {
    if (!templateStr) return '';
    return templateStr.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (match, key) => {
      const val = variables[key];
      if (val === undefined || val === null) {
        return '';
      }
      return String(val);
    });
  }

  /**
   * Resolves template by event type (DB template takes precedence over default).
   */
  async getTemplate(eventType: string): Promise<TemplateDefinition> {
    const cached = this.dbTemplateCache.get(eventType);
    if (cached && Date.now() - cached.cachedAt < this.CACHE_TTL_MS) {
      return cached.definition;
    }

    try {
      const dbTemplate = await prisma.notificationTemplate.findUnique({
        where: { code: eventType },
      });

      if (dbTemplate && dbTemplate.status === 'PUBLISHED') {
        const def: TemplateDefinition = {
          titleAr: dbTemplate.titleAr,
          titleEn: dbTemplate.titleEn,
          bodyAr: dbTemplate.bodyAr,
          bodyEn: dbTemplate.bodyEn,
          deepLinkPattern: dbTemplate.deepLinkPattern || undefined,
        };
        this.dbTemplateCache.set(eventType, { definition: def, cachedAt: Date.now() });
        return def;
      }
    } catch (_) {
      // Fallback to default templates on DB error
    }

    const fallback = this.defaultTemplates[eventType] || {
      titleAr: 'إشعار من سوقناا',
      titleEn: 'Notification from SOUQNAA',
      bodyAr: 'لديك تحديث جديد في حسابك.',
      bodyEn: 'You have a new update in your account.',
      deepLinkPattern: 'souqnaa://notifications',
    };

    return fallback;
  }

  /**
   * Renders content for a domain event using template + event variables.
   */
  async render(event: DomainNotificationEvent): Promise<RenderedNotificationContent> {
    const template = await this.getTemplate(event.eventType);
    const variables = {
      ...(event.data || {}),
      recipientId: event.recipientId,
      eventType: event.eventType,
      entityId: event.entityId,
    };

    const titleAr = (event.data?.titleAr as string) || this.interpolate(template.titleAr, variables);
    const titleEn = (event.data?.titleEn as string) || this.interpolate(template.titleEn, variables) || titleAr;
    const bodyAr = (event.data?.bodyAr as string) || (event.data?.messageAr as string) || this.interpolate(template.bodyAr, variables);
    const bodyEn = (event.data?.bodyEn as string) || (event.data?.messageEn as string) || this.interpolate(template.bodyEn, variables) || bodyAr;

    let deepLink: string | undefined = (event.data?.deepLink as string) || undefined;
    if (!deepLink && template.deepLinkPattern) {
      deepLink = this.interpolate(template.deepLinkPattern, variables);
    }

    return {
      titleAr,
      titleEn,
      bodyAr,
      bodyEn,
      deepLink,
      imageUrl: event.data?.imageUrl || event.data?.bannerUrl,
    };
  }

  /**
   * Admin: List templates
   */
  async listTemplates() {
    return prisma.notificationTemplate.findMany({
      orderBy: { code: 'asc' },
      include: { versions: { orderBy: { version: 'desc' }, take: 5 } },
    });
  }

  /**
   * Admin: Upsert a template with versioning
   */
  async upsertTemplate(data: {
    code: string;
    category: NotificationCategory;
    titleAr: string;
    titleEn: string;
    bodyAr: string;
    bodyEn: string;
    defaultPriority?: string;
    channels?: string[];
    deepLinkPattern?: string;
    changeNote?: string;
  }) {
    const existing = await prisma.notificationTemplate.findUnique({
      where: { code: data.code },
    });

    const nextVersion = existing ? existing.version + 1 : 1;
    const channelsJson = JSON.stringify(data.channels || ['PUSH', 'IN_APP']);

    const template = await prisma.notificationTemplate.upsert({
      where: { code: data.code },
      update: {
        category: data.category,
        titleAr: data.titleAr,
        titleEn: data.titleEn,
        bodyAr: data.bodyAr,
        bodyEn: data.bodyEn,
        defaultPriority: data.defaultPriority || 'NORMAL',
        channels: channelsJson,
        deepLinkPattern: data.deepLinkPattern,
        version: nextVersion,
        status: 'PUBLISHED',
      },
      create: {
        code: data.code,
        category: data.category,
        titleAr: data.titleAr,
        titleEn: data.titleEn,
        bodyAr: data.bodyAr,
        bodyEn: data.bodyEn,
        defaultPriority: data.defaultPriority || 'NORMAL',
        channels: channelsJson,
        deepLinkPattern: data.deepLinkPattern,
        version: 1,
        status: 'PUBLISHED',
      },
    });

    // Create version snapshot
    await prisma.notificationTemplateVersion.create({
      data: {
        templateId: template.id,
        version: template.version,
        titleAr: template.titleAr,
        titleEn: template.titleEn,
        bodyAr: template.bodyAr,
        bodyEn: template.bodyEn,
        channels: template.channels,
        deepLinkPattern: template.deepLinkPattern,
        status: 'PUBLISHED',
        changeNote: data.changeNote || `Version ${template.version}`,
      },
    });

    this.dbTemplateCache.delete(data.code);
    return template;
  }
}

export const notificationTemplateService = NotificationTemplateService.get();
