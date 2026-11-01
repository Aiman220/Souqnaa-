/**
 * SOUQNA — Inter-Governorate Shipment Tracking & Multi-Hub Logistics Service
 *
 * Manages tracking numbers, multi-hub transfers, checkpoints, failed delivery handling,
 * rescheduling, return-to-sender workflows, and automated customer/seller notifications.
 */

import { prisma } from '../../database/prisma';
import { AppError } from '../../middleware/error.middleware';
import { NotificationEventFactory } from '../../modules/notifications/events/domain-events';
import { notificationDispatcher } from '../../modules/notifications/services/notification-dispatcher';
import crypto from 'crypto';

export type InterGovernorateShipmentStatus =
  | 'ORDER_CONFIRMED'
  | 'SELLER_PREPARING'
  | 'READY_FOR_PICKUP'
  | 'PICKED_UP'
  | 'IN_TRANSIT'
  | 'ARRIVED_AT_HUB'
  | 'DEPARTED_HUB'
  | 'OUT_FOR_DELIVERY'
  | 'DELIVERED'
  | 'FAILED_ATTEMPT'
  | 'RESCHEDULED'
  | 'RETURN_TO_SENDER'
  | 'CANCELLED';

export interface RecordCheckpointInput {
  trackingNumber: string;
  status: InterGovernorateShipmentStatus;
  locationName: string;
  descriptionAr: string;
  descriptionEn?: string;
  hubId?: string;
  hubName?: string;
  actorType: 'SELLER' | 'CARRIER' | 'HUB_STAFF' | 'SYSTEM' | 'ADMIN' | 'CUSTOMER';
  actorId?: string;
  actorName?: string;
  failedReason?: string;
  rescheduledDate?: Date;
  notes?: string;
  metadata?: Record<string, any>;
}

export class InterGovernorateTrackingService {
  private static instance: InterGovernorateTrackingService;

  public static getInstance(): InterGovernorateTrackingService {
    if (!InterGovernorateTrackingService.instance) {
      InterGovernorateTrackingService.instance = new InterGovernorateTrackingService();
    }
    return InterGovernorateTrackingService.instance;
  }

  /**
   * Generates a unique, cryptographically random, authoritative tracking number.
   * Format: SQ-YE-<TIMESTAMP>-<RANDOM> e.g. SQ-YE-M3K9A-7F4B
   */
  public generateTrackingNumber(): string {
    const timeSegment = Date.now().toString(36).toUpperCase().slice(-5);
    const randSegment = crypto.randomBytes(2).toString('hex').toUpperCase();
    return `SQ-YE-${timeSegment}-${randSegment}`;
  }

  /**
   * Initializes initial checkpoint and DeliveryOrder when order is confirmed.
   */
  public async initializeShipment(params: {
    sellerOrderId: string;
    originCityName: string;
    destinationCityName: string;
    deliveryMethodCode?: string;
    carrierName?: string;
    estimatedDeliveryHours?: number;
    carrierCost?: number;
  }): Promise<{ trackingNumber: string; deliveryOrder: any }> {
    const {
      sellerOrderId,
      originCityName,
      destinationCityName,
      deliveryMethodCode = 'intercity_transport',
      carrierName = 'البريد اليمني / خطوط النقل المعتمدة',
      estimatedDeliveryHours = 48,
      carrierCost = 0,
    } = params;

    // Check if delivery order already exists for this sellerOrder
    let deliveryOrder = await prisma.deliveryOrder.findUnique({
      where: { sellerOrderId },
    });

    const trackingNumber = deliveryOrder?.trackingNumber || this.generateTrackingNumber();

    const estimatedDeliveryAt = new Date(Date.now() + estimatedDeliveryHours * 3600 * 1000);

    if (!deliveryOrder) {
      deliveryOrder = await prisma.deliveryOrder.create({
        data: {
          sellerOrderId,
          trackingNumber,
          carrierName,
          status: 'ORDER_CONFIRMED',
          deliveryMethodCode,
          carrierCost,
          estimatedDeliveryAt,
        },
      });
    }

    // Update SellerOrder with tracking number
    await prisma.sellerOrder.update({
      where: { id: sellerOrderId },
      data: {
        trackingNumber,
        isInterGovernorate: true,
        carrierName,
        carrierCost,
      },
    });

    // Record initial checkpoint
    await prisma.interGovernorateTrackingCheckpoint.create({
      data: {
        sellerOrderId,
        trackingNumber,
        status: 'ORDER_CONFIRMED',
        stageIndex: 1,
        locationName: originCityName,
        descriptionAr: `تم تأكيد الطلب وبدء إجراءات الشحن من ${originCityName} إلى ${destinationCityName}`,
        descriptionEn: `Order confirmed, shipping initiated from ${originCityName} to ${destinationCityName}`,
        actorType: 'SYSTEM',
      },
    });

    return { trackingNumber, deliveryOrder };
  }

  /**
   * Records a tracking checkpoint and automatically advances delivery/order state
   * and sends push/in-app notifications to customer and seller.
   */
  public async recordCheckpoint(input: RecordCheckpointInput): Promise<any> {
    const {
      trackingNumber,
      status,
      locationName,
      descriptionAr,
      descriptionEn,
      hubId,
      hubName,
      actorType,
      actorId,
      actorName,
      failedReason,
      rescheduledDate,
      notes,
      metadata,
    } = input;

    const deliveryOrder = await prisma.deliveryOrder.findUnique({
      where: { trackingNumber },
      include: {
        sellerOrder: {
          include: {
            order: {
              include: { user: true },
            },
            seller: {
              include: { user: true },
            },
          },
        },
      },
    });

    if (!deliveryOrder) {
      throw new AppError('رقم التتبع غير موجود في النظام', 404, 'TRACKING_NOT_FOUND');
    }

    const sellerOrderId = deliveryOrder.sellerOrderId;
    const parentOrderId = deliveryOrder.sellerOrder.orderId;
    const customerUserId = deliveryOrder.sellerOrder.order.userId;
    const sellerUserId = deliveryOrder.sellerOrder.seller.userId;

    // Count existing checkpoints to determine stageIndex
    const checkpointCount = await prisma.interGovernorateTrackingCheckpoint.count({
      where: { trackingNumber },
    });

    const checkpoint = await prisma.interGovernorateTrackingCheckpoint.create({
      data: {
        sellerOrderId,
        trackingNumber,
        status,
        stageIndex: checkpointCount + 1,
        hubId,
        hubName,
        locationName,
        descriptionAr,
        descriptionEn: descriptionEn || descriptionAr,
        actorType,
        actorId,
        actorName,
        failedReason,
        rescheduledDate,
        notes,
        metadata: metadata ? JSON.stringify(metadata) : null,
      },
    });

    // Update DeliveryOrder status & timestamps
    const updateData: any = {
      status,
    };

    if (status === 'PICKED_UP') {
      updateData.pickupTime = new Date();
    } else if (status === 'DELIVERED') {
      updateData.deliveryTime = new Date();
    } else if (status === 'FAILED_ATTEMPT') {
      updateData.failedReason = failedReason;
    } else if (status === 'RESCHEDULED' && rescheduledDate) {
      updateData.rescheduledAt = rescheduledDate;
      updateData.estimatedDeliveryAt = rescheduledDate;
    }
    if (hubId) {
      updateData.currentHubId = hubId;
    }

    await prisma.deliveryOrder.update({
      where: { trackingNumber },
      data: updateData,
    });

    // Sync SellerOrder status if appropriate
    let sellerOrderStatusUpdate: any = null;
    if (status === 'SELLER_PREPARING') {
      sellerOrderStatusUpdate = 'PROCESSING';
    } else if (status === 'READY_FOR_PICKUP') {
      sellerOrderStatusUpdate = 'READY_TO_SHIP';
    } else if (['PICKED_UP', 'IN_TRANSIT', 'ARRIVED_AT_HUB', 'DEPARTED_HUB', 'OUT_FOR_DELIVERY'].includes(status)) {
      sellerOrderStatusUpdate = 'SHIPPED';
    } else if (status === 'DELIVERED') {
      sellerOrderStatusUpdate = 'DELIVERED';
    }

    if (sellerOrderStatusUpdate) {
      await prisma.sellerOrder.update({
        where: { id: sellerOrderId },
        data: {
          status: sellerOrderStatusUpdate,
          ...(sellerOrderStatusUpdate === 'DELIVERED' ? { deliveredAt: new Date() } : {}),
        },
      });

      // Also record OrderStatusHistory
      await prisma.orderStatusHistory.create({
        data: {
          orderId: parentOrderId,
          sellerOrderId,
          fromStatus: deliveryOrder.sellerOrder.status,
          toStatus: sellerOrderStatusUpdate,
          changedBy: actorId || actorType,
          changedByRole: actorType,
          reason: descriptionAr,
          note: `Inter-governorate shipment: ${trackingNumber}`,
        },
      });
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Notifications Dispatcher Integration
    // ──────────────────────────────────────────────────────────────────────────
    try {
      const displayOrderNumber =
        deliveryOrder.sellerOrder.order.displayOrderNumber ||
        deliveryOrder.sellerOrder.order.orderNumber;

      // Notify Customer
      if (customerUserId) {
        let eventType: any = 'ORDER_SHIPPED';
        if (status === 'OUT_FOR_DELIVERY') eventType = 'ORDER_OUT_FOR_DELIVERY';
        if (status === 'DELIVERED') eventType = 'ORDER_DELIVERED';
        if (status === 'CANCELLED') eventType = 'ORDER_CANCELLED';

        notificationDispatcher.dispatch(
          NotificationEventFactory.orderEvent({
            eventType,
            recipientId: customerUserId,
            orderId: parentOrderId,
            orderNumber: displayOrderNumber,
          }),
        );
      }

      // Notify Seller on pickup / delivery / failure
      if (sellerUserId && ['PICKED_UP', 'DELIVERED', 'FAILED_ATTEMPT', 'RETURN_TO_SENDER'].includes(status)) {
        notificationDispatcher.dispatch(
          NotificationEventFactory.sellerOrderReceivedEvent({
            recipientId: sellerUserId,
            orderId: parentOrderId,
            sellerOrderId,
            orderNumber: displayOrderNumber,
          }),
        );
      }
    } catch (notifErr) {
      console.warn('[InterGovernorateTrackingService] Notification dispatch warning:', notifErr);
    }

    return checkpoint;
  }

  /**
   * Public or authorized tracking query: returns full timeline and current status.
   */
  public async getTrackingTimeline(trackingNumber: string): Promise<any> {
    const deliveryOrder = await prisma.deliveryOrder.findUnique({
      where: { trackingNumber },
      include: {
        sellerOrder: {
          include: {
            order: {
              include: {
                deliveryAddress: {
                  include: { city: true },
                },
              },
            },
            seller: {
              include: {
                stores: true,
              },
            },
            deliveryQuoteSnapshot: true,
          },
        },
      },
    });

    if (!deliveryOrder) {
      throw new AppError('رقم التتبع غير موجود', 404, 'TRACKING_NOT_FOUND');
    }

    const checkpoints = await prisma.interGovernorateTrackingCheckpoint.findMany({
      where: { trackingNumber },
      orderBy: { stageIndex: 'asc' },
    });

    const sellerOrder = deliveryOrder.sellerOrder;
    const store = (sellerOrder.seller as any)?.stores?.[0];
    const destAddress = sellerOrder.order?.deliveryAddress;
    const snapshot = sellerOrder.deliveryQuoteSnapshot;

    return {
      trackingNumber,
      currentStatus: deliveryOrder.status,
      carrierName: deliveryOrder.carrierName || 'البريد اليمني / خطوط النقل المعتمدة',
      driverName: deliveryOrder.driverName,
      driverPhone: deliveryOrder.driverPhone,
      deliveryMethodCode: deliveryOrder.deliveryMethodCode,
      estimatedDeliveryAt: deliveryOrder.estimatedDeliveryAt,
      rescheduledAt: deliveryOrder.rescheduledAt,
      failedReason: deliveryOrder.failedReason,
      pickupTime: deliveryOrder.pickupTime,
      deliveryTime: deliveryOrder.deliveryTime,
      origin: {
        storeName: store?.name || 'متجر سوقنا',
        cityName: snapshot?.zoneName || store?.city || 'صنعاء',
      },
      destination: {
        cityName: destAddress?.city?.nameAr || 'اليمن',
        street: destAddress?.street,
        recipientName: destAddress?.recipientName,
      },
      packageInfo: {
        actualWeightKg: snapshot?.actualWeightKg,
        chargeableWeightKg: snapshot?.chargeableWeightKg,
        roadDistanceKm: snapshot?.roadDistanceKm,
      },
      checkpoints: checkpoints.map((cp: any) => ({
        id: cp.id,
        status: cp.status,
        stageIndex: cp.stageIndex,
        locationName: cp.locationName,
        hubName: cp.hubName,
        descriptionAr: cp.descriptionAr,
        descriptionEn: cp.descriptionEn,
        actorType: cp.actorType,
        failedReason: cp.failedReason,
        rescheduledDate: cp.rescheduledDate,
        timestamp: cp.createdAt,
      })),
    };
  }

  /**
   * Hub CRUD & Transit Management
   */
  public async createHub(data: any): Promise<any> {
    const { code, nameAr, nameEn, governorate, areaId, address, latitude, longitude, contactPhone, operatingHours, isPickupPoint } = data;
    if (!code || !nameAr || !governorate || !areaId || latitude == null || longitude == null) {
      throw new AppError('بيانات المركز أو نقطة الاستلام غير مكتملة', 400);
    }
    return await prisma.interGovernorateHub.create({
      data: {
        code,
        nameAr,
        nameEn: nameEn || nameAr,
        governorate,
        areaId,
        address: address || governorate,
        latitude: parseFloat(String(latitude)),
        longitude: parseFloat(String(longitude)),
        contactPhone,
        operatingHours,
        isPickupPoint: Boolean(isPickupPoint),
        isActive: true,
      },
    });
  }

  public async listHubs(params: { areaId?: string; isPickupPoint?: boolean } = {}): Promise<any[]> {
    const where: any = { isActive: true };
    if (params.areaId) where.areaId = params.areaId;
    if (params.isPickupPoint !== undefined) where.isPickupPoint = params.isPickupPoint;

    return await prisma.interGovernorateHub.findMany({
      where,
      orderBy: { nameAr: 'asc' },
    });
  }
}

export const interGovernorateTrackingService = InterGovernorateTrackingService.getInstance();
