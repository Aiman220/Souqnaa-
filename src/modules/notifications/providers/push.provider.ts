import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import {
  NotificationChannel,
  NotificationPriority,
} from '../notification.types';
import {
  NotificationProvider,
  ProviderSendParams,
  ProviderSendResult,
} from './notification-provider.interface';

interface GoogleCredentials {
  projectId: string;
  clientEmail: string;
  privateKey: string;
}

export class FcmPushProvider implements NotificationProvider {
  channel = NotificationChannel.PUSH;
  providerName = 'FCM';

  private cachedAccessToken: { token: string; expiresAt: number } | null = null;

  /**
   * Resolves the Android Notification Channel ID from the category.
   */
  public getAndroidChannelId(category: string): string {
    switch (category.toUpperCase()) {
      case 'ORDER':
      case 'ORDERS':
        return 'souqna_orders_channel';
      case 'PAYMENT':
      case 'PAYMENTS':
      case 'WALLET':
        return 'souqna_payments_channel';
      case 'REFUND':
      case 'REFUNDS':
        return 'souqna_refunds_channel';
      case 'CHAT':
      case 'SUPPORT':
        return 'souqna_chat_channel';
      case 'PROMOTION':
      case 'FLASH_SALE':
      case 'MEGA_CAMPAIGN':
      case 'COUPON':
      case 'CAMPAIGN':
        return 'souqna_promotions_channel';
      case 'REWARDS':
        return 'souqna_rewards_channel';
      case 'SECURITY':
      case 'AUTH':
        return 'souqna_security_channel';
      default:
        return 'souqna_system_channel';
    }
  }

  /**
   * Mask device token for privacy and security audits.
   * Never logs complete device tokens.
   */
  public sanitizeToken(token: string): string {
    if (!token || token.length < 10) return '***';
    return `${token.substring(0, 6)}...${token.substring(token.length - 4)}`;
  }

  /**
   * Sanitizes and formats RSA PEM private key.
   * Strips outer quotes, expands escaped newlines, and normalizes line breaks.
   */
  private formatPrivateKey(rawKey: string): string {
    let key = rawKey.trim();
    if ((key.startsWith('"') && key.endsWith('"')) || (key.startsWith("'") && key.endsWith("'"))) {
      key = key.slice(1, -1);
    }
    key = key.replace(/\\n/g, '\n').replace(/\r\n/g, '\n');
    if (!key.endsWith('\n')) {
      key += '\n';
    }
    return key;
  }

  /**
   * Resolves Google Service Account credentials from environment or config.
   */
  public getGoogleCredentials(): GoogleCredentials | null {
    let projectId = process.env.FIREBASE_PROJECT_ID || process.env.FCM_PROJECT_ID;
    let clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
    let privateKey = process.env.FIREBASE_PRIVATE_KEY;

    const saEnv = process.env.FIREBASE_SERVICE_ACCOUNT || process.env.GOOGLE_APPLICATION_CREDENTIALS;
    let loadedJson: any = null;

    if (saEnv && saEnv.trim().startsWith('{') && saEnv.trim().endsWith('}')) {
      try {
        loadedJson = JSON.parse(saEnv);
      } catch (err: any) {
        console.error('[FCM Push] Failed to parse inline FIREBASE_SERVICE_ACCOUNT JSON:', err.message);
      }
    }

    if (!loadedJson) {
      const saBasename = saEnv ? path.basename(saEnv) : 'firebase-service-account.json';
      const candidatePaths = [
        saEnv,
        saEnv ? path.resolve(process.cwd(), saEnv) : null,
        path.resolve(process.cwd(), 'config', saBasename),
        path.resolve(process.cwd(), 'backend/config', saBasename),
        path.resolve(__dirname, '../../../../config', saBasename),
        path.resolve(__dirname, '../../../config', saBasename),
        path.resolve(__dirname, '../../config', saBasename),
        path.resolve(__dirname, '../config', saBasename),
      ].filter((p): p is string => Boolean(p && typeof p === 'string'));

      for (const candidate of candidatePaths) {
        try {
          if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
            const raw = fs.readFileSync(candidate, 'utf8');
            loadedJson = JSON.parse(raw);
            break;
          }
        } catch (_) {}
      }
    }

    if (loadedJson) {
      if (loadedJson.project_id) projectId = loadedJson.project_id;
      if (loadedJson.client_email) clientEmail = loadedJson.client_email;
      if (loadedJson.private_key) privateKey = loadedJson.private_key;
    }

    // Canonical project ID normalization (guards against stale placeholder env vars)
    if (projectId === 'souqnaa-marketplace') {
      projectId = 'souqnaa';
    }

    if (projectId && clientEmail && privateKey) {
      return {
        projectId,
        clientEmail,
        privateKey: this.formatPrivateKey(privateKey),
      };
    }

    return null;
  }

  /**
   * Retrieves or refreshes Google OAuth2 access token using RS256 JWT assertion.
   */
  private async getAccessToken(creds: GoogleCredentials): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    if (this.cachedAccessToken && this.cachedAccessToken.expiresAt > now + 60) {
      return this.cachedAccessToken.token;
    }

    const header = { alg: 'RS256', typ: 'JWT' };
    const payload = {
      iss: creds.clientEmail,
      scope: 'https://www.googleapis.com/auth/firebase.messaging',
      aud: 'https://oauth2.googleapis.com/token',
      exp: now + 3600,
      iat: now,
    };

    const b64url = (input: any) =>
      Buffer.from(typeof input === 'string' ? input : JSON.stringify(input)).toString('base64url');

    const unsignedToken = `${b64url(header)}.${b64url(payload)}`;
    const signer = crypto.createSign('RSA-SHA256');
    signer.update(unsignedToken);
    const signature = signer.sign(creds.privateKey, 'base64url');
    const assertion = `${unsignedToken}.${signature}`;

    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Google OAuth2 token exchange failed (${res.status}): ${errText}`);
    }

    const data = (await res.json()) as any;
    this.cachedAccessToken = {
      token: data.access_token,
      expiresAt: now + (data.expires_in || 3600),
    };

    return data.access_token;
  }

  /**
   * Builds platform-compliant FCM HTTP v1 payload with stringified data fields.
   */
  public buildFcmMessage(token: string, params: ProviderSendParams) {
    const channelId = this.getAndroidChannelId(params.category || 'SYSTEM');
    const isUrgent = params.priority === NotificationPriority.URGENT;
    const isHigh = isUrgent || params.priority === NotificationPriority.HIGH;

    const resolvedDeepLink = params.content.deepLink || (params.data?.deepLink as string) || '';
    const resolvedEntityType = params.entityType || (params.data?.entityType as string) || '';
    const resolvedEntityId = params.entityId || (params.data?.entityId as string) || '';

    const dataEntries: Record<string, string> = {
      notificationId: String(params.notificationId || ''),
      category: String(params.category || 'SYSTEM'),
      entityType: String(resolvedEntityType),
      entityId: String(resolvedEntityId),
      deepLink: String(resolvedDeepLink),
      titleAr: String(params.content.titleAr || ''),
      titleEn: String(params.content.titleEn || ''),
      bodyAr: String(params.content.bodyAr || ''),
      bodyEn: String(params.content.bodyEn || ''),
    };

    if (params.data) {
      for (const [k, v] of Object.entries(params.data)) {
        if (v !== undefined && v !== null && (!dataEntries[k] || dataEntries[k] === '')) {
          dataEntries[k] = typeof v === 'string' ? v : JSON.stringify(v);
        }
      }
    }

    return {
      message: {
        token,
        notification: {
          title: params.content.titleAr,
          body: params.content.bodyAr,
          ...(params.content.imageUrl ? { image: params.content.imageUrl } : {}),
        },
        data: dataEntries,
        android: {
          priority: isHigh ? 'HIGH' : 'NORMAL',
          notification: {
            channel_id: channelId,
            sound: 'default',
            click_action: 'FLUTTER_NOTIFICATION_CLICK',
            icon: 'ic_notification',
            color: '#10B981',
          },
        },
        apns: {
          headers: {
            'apns-priority': isHigh ? '10' : '5',
          },
          payload: {
            aps: {
              alert: {
                title: params.content.titleAr,
                body: params.content.bodyAr,
              },
              badge: 1,
              sound: 'default',
              category: params.category || 'SYSTEM',
            },
          },
        },
        webpush: {
          headers: {
            Urgency: isHigh ? 'high' : 'normal',
          },
          notification: {
            icon: '/icons/Icon-192.png',
            badge: '/icons/Icon-192.png',
            dir: 'rtl',
            lang: 'ar',
            data: {
              deepLink: params.content.deepLink || '',
            },
          },
        },
      },
    };
  }

  async send(params: ProviderSendParams): Promise<ProviderSendResult> {
    const tokens = params.deviceTokens || [];
    if (tokens.length === 0) {
      return {
        success: true,
        provider: this.providerName,
        channel: this.channel,
        messageId: 'no_tokens_noop',
      };
    }

    // Deduplicate tokens to guarantee no recipient receives multiple identical push deliveries
    const uniqueTokens = Array.from(new Set(tokens.filter((t): t is string => Boolean(t && typeof t === 'string'))));
    const fcmTokens = uniqueTokens.filter((t) => !t.startsWith('local_'));
    const localTokens = uniqueTokens.filter((t) => t.startsWith('local_'));
    if (localTokens.length > 0) {
      console.log(
        `[FCM Push] Skipped ${localTokens.length} local pseudo-token(s) for recipient ${params.recipientId}`
      );
    }

    if (fcmTokens.length === 0) {
      return {
        success: true,
        provider: this.providerName,
        channel: this.channel,
        messageId: 'local_tokens_noop',
      };
    }

    const creds = this.getGoogleCredentials();
    const serverKey = process.env.FCM_SERVER_KEY;

    if (!creds && !serverKey) {
      console.warn(
        `[FCM Push] FCM credentials not configured in environment. Cannot deliver push to ${fcmTokens.length} token(s) for user ${params.recipientId}.`
      );
      return {
        success: false,
        provider: this.providerName,
        channel: this.channel,
        error: 'Push provider credentials not configured (missing FIREBASE_PROJECT_ID / FIREBASE_SERVICE_ACCOUNT / FCM_SERVER_KEY)',
        invalidTokens: [],
      };
    }

    const invalidTokens: string[] = [];
    const successfulMessageIds: string[] = [];
    const errors: string[] = [];

    // Deliver via FCM HTTP v1 API
    if (creds) {
      try {
        console.log(
          `[FCM Push] [push_delivery_started] recipientId=${params.recipientId} category=${params.category || 'SYSTEM'} tokenCount=${fcmTokens.length}`
        );
        const accessToken = await this.getAccessToken(creds);
        const url = `https://fcm.googleapis.com/v1/projects/${creds.projectId}/messages:send`;

        for (const token of fcmTokens) {
          const payload = this.buildFcmMessage(token, params);
          try {
            const res = await fetch(url, {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${accessToken}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify(payload),
            });

            if (res.ok) {
              const resJson = (await res.json()) as any;
              successfulMessageIds.push(resJson.name || `msg_${Date.now()}`);
              console.log(
                `[FCM Push] [fcm_provider_accepted_or_rejected] status=ACCEPTED token=${this.sanitizeToken(token)} user=${params.recipientId} messageId=${resJson.name}`
              );
            } else {
              const errBody = await res.text();
              const sanitizedErr = errBody.replace(/[A-Za-z0-9_-]{20,}/g, '***');
              errors.push(`Status ${res.status}: ${sanitizedErr}`);
              console.warn(
                `[FCM Push] [fcm_provider_accepted_or_rejected] status=REJECTED token=${this.sanitizeToken(token)} httpStatus=${res.status} error=${sanitizedErr}`
              );

              if (
                res.status === 404 ||
                errBody.includes('UNREGISTERED') ||
                errBody.includes('NOT_FOUND') ||
                errBody.includes('registration-token-not-registered') ||
                errBody.includes('INVALID_ARGUMENT')
              ) {
                invalidTokens.push(token);
                console.warn(`[FCM Push] Token invalid/unregistered: ${this.sanitizeToken(token)}`);
              }
            }
          } catch (netErr: any) {
            errors.push(netErr.message);
          }
        }
      } catch (authErr: any) {
        console.error('[FCM Push] Authentication failure:', authErr.message);
        return {
          success: false,
          provider: this.providerName,
          channel: this.channel,
          error: `Provider authentication failure: ${authErr.message}`,
        };
      }
    } else if (serverKey) {
      // Legacy FCM HTTP Send fallback
      try {
        const res = await fetch('https://fcm.googleapis.com/fcm/send', {
          method: 'POST',
          headers: {
            Authorization: `key=${serverKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            registration_ids: fcmTokens,
            notification: {
              title: params.content.titleAr,
              body: params.content.bodyAr,
            },
            data: {
              notificationId: params.notificationId || '',
              category: params.category || 'SYSTEM',
              deepLink: params.content.deepLink || '',
            },
          }),
        });

        if (res.ok) {
          const resJson = (await res.json()) as any;
          if (resJson.results && Array.isArray(resJson.results)) {
            resJson.results.forEach((r: any, idx: number) => {
              if (r.error === 'NotRegistered' || r.error === 'InvalidRegistration') {
                invalidTokens.push(fcmTokens[idx]);
              }
            });
          }
          successfulMessageIds.push(`legacy_${Date.now()}`);
        } else {
          errors.push(`Legacy FCM HTTP ${res.status}`);
        }
      } catch (err: any) {
        errors.push(err.message);
      }
    }

    if (successfulMessageIds.length > 0) {
      return {
        success: true,
        provider: this.providerName,
        channel: this.channel,
        messageId: successfulMessageIds[0],
        invalidTokens,
      };
    }

    return {
      success: false,
      provider: this.providerName,
      channel: this.channel,
      error: errors.join('; ') || 'Push transmission failed for all recipient tokens',
      invalidTokens,
    };
  }
}

export const fcmPushProvider = new FcmPushProvider();
