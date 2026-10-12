/**
 * SOUQNA — UNIVERSAL SHIPPING PROMOTIONS SYSTEM
 * Shipping Campaign Service
 * Version: 2.0.0
 */

import { prisma } from '../../../database/prisma';

export class ShippingCampaignService {
  /**
   * Associates a shipping promotion with a campaign.
   */
  public static async attachPromotionToCampaign(params: {
    promotionId: string;
    campaignId: string;
    actorId: string;
  }) {
    const { promotionId, campaignId, actorId } = params;

    const campaign = await prisma.campaign.findUnique({
      where: { id: campaignId },
    });

    if (!campaign) {
      throw new Error(`Campaign ${campaignId} not found`);
    }

    const updated = await prisma.shippingPromotion.update({
      where: { id: promotionId },
      data: {
        campaignId,
        updatedBy: actorId,
      },
    });

    await prisma.shippingPromotionAuditLog.create({
      data: {
        promotionId,
        actorId,
        action: 'ATTACH_TO_CAMPAIGN',
        newValue: JSON.stringify({ campaignId, campaignName: campaign.name }),
        reason: `Attached to campaign '${campaign.name}'`,
      },
    });

    return updated;
  }

  /**
   * Retrieves all shipping promotions belonging to a campaign.
   */
  public static async getCampaignShippingPromotions(campaignId: string) {
    return await prisma.shippingPromotion.findMany({
      where: { campaignId },
      orderBy: { priority: 'desc' },
      include: {
        campaign: { select: { id: true, name: true, slug: true, status: true } },
      },
    });
  }
}
