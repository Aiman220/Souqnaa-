import http from 'http';
import https from 'https';

export interface InvalidationPayload {
  tags?: string[];
  paths?: string[];
}

/**
 * Service to notify the public storefront web application when public products,
 * categories, or stores are modified. Non-blocking and resilient to network errors.
 */
export class StorefrontInvalidatorService {
  private static revalidateUrl = process.env.STOREFRONT_REVALIDATE_URL;
  private static revalidateSecret = process.env.STOREFRONT_REVALIDATE_SECRET;

  /**
   * Dispatches an asynchronous cache invalidation request to the storefront web app.
   */
  static triggerInvalidation(payload: InvalidationPayload): void {
    const urlStr = this.revalidateUrl || process.env.STOREFRONT_REVALIDATE_URL;
    const secret = this.revalidateSecret || process.env.STOREFRONT_REVALIDATE_SECRET;

    if (!urlStr || !secret) {
      return; // Revalidation not configured in this environment
    }

    try {
      const url = new URL(urlStr);
      const postData = JSON.stringify(payload);
      const isHttps = url.protocol === 'https:';
      const client = isHttps ? https : http;

      const options = {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData),
          'x-revalidate-secret': secret,
          'User-Agent': 'SouqnaaBackend/1.0',
        },
        timeout: 4000, // 4-second bounded timeout
      };

      const req = client.request(options, (res) => {
        if (res.statusCode && res.statusCode >= 400) {
          console.warn(`[StorefrontInvalidator] Webhook responded with status: ${res.statusCode}`);
        }
      });

      req.on('error', (err) => {
        console.warn(`[StorefrontInvalidator] Webhook request error: ${err.message}`);
      });

      req.on('timeout', () => {
        req.destroy();
        console.warn('[StorefrontInvalidator] Webhook request timed out after 4000ms');
      });

      req.write(postData);
      req.end();
    } catch (err: any) {
      console.warn(`[StorefrontInvalidator] Failed to dispatch webhook: ${err.message}`);
    }
  }

  /**
   * Helper: invalidate product caches
   */
  static invalidateProduct(productId: string, slug?: string): void {
    const tags = ['products', 'home', `product-${productId}`];
    if (slug) tags.push(`product-${slug}`);
    this.triggerInvalidation({ tags });
  }

  /**
   * Helper: invalidate category caches
   */
  static invalidateCategory(categoryId: string, slug?: string): void {
    const tags = ['categories', 'home', 'sitemap', `category-${categoryId}`];
    if (slug) tags.push(`category-${slug}`);
    this.triggerInvalidation({ tags });
  }

  /**
   * Helper: invalidate store storefront caches
   */
  static invalidateStore(storeId: string, slug?: string): void {
    const tags = ['stores', 'home', `store-${storeId}`];
    if (slug) tags.push(`store-${slug}`);
    this.triggerInvalidation({ tags });
  }
}
