import { RemoteConfigService } from '../../remote-config/remote-config.service';
import { CartAbandonmentConfig } from './cart-abandonment.types';

export const DEFAULT_CART_ABANDONMENT_CONFIG: CartAbandonmentConfig = {
  cart_abandonment_reminders_enabled: true,
  cart_abandonment_first_delay_minutes: 360, // 6 hours
  cart_abandonment_second_delay_minutes: 1440, // 24 hours later
  cart_abandonment_max_reminders: 2,
  cart_abandonment_customer_daily_limit: 1, // Max 1 per 24 hours
  cart_abandonment_customer_weekly_limit: 3, // Max 3 per 7 days
  cart_abandonment_min_items: 1,
  cart_abandonment_min_cart_value: 0,
  cart_abandonment_require_push_permission: false,
  cart_abandonment_quiet_hours_enabled: true,
  cart_abandonment_quiet_hours: {
    start: '22:00',
    end: '08:00',
  },
  cart_abandonment_personalization_enabled: true,
  cart_abandonment_cart_expiration_days: 14,
  cart_abandonment_cart_open_cooldown_minutes: 60,
  cart_abandonment_recent_order_cooldown_hours: 2,
  cart_abandonment_attribution_window_hours: 72,
};

export class CartAbandonmentConfigService {
  private static instance: CartAbandonmentConfigService;
  private overrideConfig: Partial<CartAbandonmentConfig> = {};

  static get(): CartAbandonmentConfigService {
    if (!CartAbandonmentConfigService.instance) {
      CartAbandonmentConfigService.instance = new CartAbandonmentConfigService();
    }
    return CartAbandonmentConfigService.instance;
  }

  /**
   * Set dynamic test or admin runtime overrides
   */
  setOverrides(overrides: Partial<CartAbandonmentConfig>) {
    this.overrideConfig = { ...this.overrideConfig, ...overrides };
  }

  clearOverrides() {
    this.overrideConfig = {};
  }

  /**
   * Authoritative resolution from Remote Config with fail-safe defaults
   */
  async getConfig(): Promise<CartAbandonmentConfig> {
    try {
      const remoteConfigService = RemoteConfigService.getInstance();
      const resolved = await remoteConfigService.getResolvedConfig({});

      const flag = resolved.details?.['cart_abandonment_reminders_enabled'];
      const isEnabled = resolved.features?.['cart_abandonment_reminders_enabled'] ?? DEFAULT_CART_ABANDONMENT_CONFIG.cart_abandonment_reminders_enabled;

      const metadata = (flag?.metadata || {}) as Record<string, any>;

      return {
        cart_abandonment_reminders_enabled:
          this.overrideConfig.cart_abandonment_reminders_enabled ?? isEnabled,

        cart_abandonment_first_delay_minutes:
          this.overrideConfig.cart_abandonment_first_delay_minutes ??
          (typeof metadata.first_delay_minutes === 'number'
            ? metadata.first_delay_minutes
            : DEFAULT_CART_ABANDONMENT_CONFIG.cart_abandonment_first_delay_minutes),

        cart_abandonment_second_delay_minutes:
          this.overrideConfig.cart_abandonment_second_delay_minutes ??
          (typeof metadata.second_delay_minutes === 'number'
            ? metadata.second_delay_minutes
            : DEFAULT_CART_ABANDONMENT_CONFIG.cart_abandonment_second_delay_minutes),

        cart_abandonment_max_reminders:
          this.overrideConfig.cart_abandonment_max_reminders ??
          (typeof metadata.max_reminders === 'number'
            ? metadata.max_reminders
            : DEFAULT_CART_ABANDONMENT_CONFIG.cart_abandonment_max_reminders),

        cart_abandonment_customer_daily_limit:
          this.overrideConfig.cart_abandonment_customer_daily_limit ??
          (typeof metadata.customer_daily_limit === 'number'
            ? metadata.customer_daily_limit
            : DEFAULT_CART_ABANDONMENT_CONFIG.cart_abandonment_customer_daily_limit),

        cart_abandonment_customer_weekly_limit:
          this.overrideConfig.cart_abandonment_customer_weekly_limit ??
          (typeof metadata.customer_weekly_limit === 'number'
            ? metadata.customer_weekly_limit
            : DEFAULT_CART_ABANDONMENT_CONFIG.cart_abandonment_customer_weekly_limit),

        cart_abandonment_min_items:
          this.overrideConfig.cart_abandonment_min_items ??
          (typeof metadata.min_items === 'number'
            ? metadata.min_items
            : DEFAULT_CART_ABANDONMENT_CONFIG.cart_abandonment_min_items),

        cart_abandonment_min_cart_value:
          this.overrideConfig.cart_abandonment_min_cart_value ??
          (typeof metadata.min_cart_value === 'number'
            ? metadata.min_cart_value
            : DEFAULT_CART_ABANDONMENT_CONFIG.cart_abandonment_min_cart_value),

        cart_abandonment_require_push_permission:
          this.overrideConfig.cart_abandonment_require_push_permission ??
          (typeof metadata.require_push_permission === 'boolean'
            ? metadata.require_push_permission
            : DEFAULT_CART_ABANDONMENT_CONFIG.cart_abandonment_require_push_permission),

        cart_abandonment_quiet_hours_enabled:
          this.overrideConfig.cart_abandonment_quiet_hours_enabled ??
          (typeof metadata.quiet_hours_enabled === 'boolean'
            ? metadata.quiet_hours_enabled
            : DEFAULT_CART_ABANDONMENT_CONFIG.cart_abandonment_quiet_hours_enabled),

        cart_abandonment_quiet_hours:
          this.overrideConfig.cart_abandonment_quiet_hours ??
          (metadata.quiet_hours && typeof metadata.quiet_hours.start === 'string'
            ? metadata.quiet_hours
            : DEFAULT_CART_ABANDONMENT_CONFIG.cart_abandonment_quiet_hours),

        cart_abandonment_personalization_enabled:
          this.overrideConfig.cart_abandonment_personalization_enabled ??
          (typeof metadata.personalization_enabled === 'boolean'
            ? metadata.personalization_enabled
            : DEFAULT_CART_ABANDONMENT_CONFIG.cart_abandonment_personalization_enabled),

        cart_abandonment_cart_expiration_days:
          this.overrideConfig.cart_abandonment_cart_expiration_days ??
          (typeof metadata.cart_expiration_days === 'number'
            ? metadata.cart_expiration_days
            : DEFAULT_CART_ABANDONMENT_CONFIG.cart_abandonment_cart_expiration_days),

        cart_abandonment_cart_open_cooldown_minutes:
          this.overrideConfig.cart_abandonment_cart_open_cooldown_minutes ??
          (typeof metadata.cart_open_cooldown_minutes === 'number'
            ? metadata.cart_open_cooldown_minutes
            : DEFAULT_CART_ABANDONMENT_CONFIG.cart_abandonment_cart_open_cooldown_minutes),

        cart_abandonment_recent_order_cooldown_hours:
          this.overrideConfig.cart_abandonment_recent_order_cooldown_hours ??
          (typeof metadata.recent_order_cooldown_hours === 'number'
            ? metadata.recent_order_cooldown_hours
            : DEFAULT_CART_ABANDONMENT_CONFIG.cart_abandonment_recent_order_cooldown_hours),

        cart_abandonment_attribution_window_hours:
          this.overrideConfig.cart_abandonment_attribution_window_hours ??
          (typeof metadata.attribution_window_hours === 'number'
            ? metadata.attribution_window_hours
            : DEFAULT_CART_ABANDONMENT_CONFIG.cart_abandonment_attribution_window_hours),
      };
    } catch {
      return {
        ...DEFAULT_CART_ABANDONMENT_CONFIG,
        ...this.overrideConfig,
      };
    }
  }
}

export const cartAbandonmentConfigService = CartAbandonmentConfigService.get();
