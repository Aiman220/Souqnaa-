import { config } from './config';
import http from 'http';
import { createApp } from './app';
import { SocketService } from './services/websocket/socket.service';
import { WishlistAlertsJob } from './services/jobs/wishlist-alerts.job';
import { FlashSaleScheduler } from './services/jobs/flash-sale.job';
import { FollowScheduler } from './services/jobs/follow-counter.job';
import { CampaignBannerScheduler } from './services/jobs/campaign-banner.job';
import { RecommendationJobs } from './modules/recommendations/jobs/recommendation.jobs';
import { RewardsScheduler } from './services/jobs/rewards.job';
import { NotificationScheduler } from './modules/notifications/services/notification-scheduler';
import { CartAbandonmentJob } from './services/jobs/cart-abandonment.job';
import { SellerReserveScheduler } from './services/jobs/seller-reserve.job';
import { prisma } from './database/prisma';
import { redis } from './database/redis';
import { remoteConfigService } from './modules/remote-config/remote-config.service';

const startServer = async () => {
  try {
    const app = createApp();
    const server = http.createServer(app);

    // HTTP Keep-Alive connection reuse & timeout hardening for Cloudflare / Render proxy (§1, §2, §3)
    server.keepAliveTimeout = 65000; // Keep sockets open slightly longer than Cloudflare's 60s idle timeout
    server.headersTimeout = 66000;   // Headers timeout must exceed keepAliveTimeout per Node.js specification

    // Initialize Realtime WebSocket (Socket.io)
    SocketService.init(server);

    // Initialize Remote Configuration & System Feature Flags (§40)
    remoteConfigService.ensureInitialized().catch((err) => {
      console.warn('[RemoteConfig] Deferred init warning:', err?.message);
    });

    // Initialize Centralized SOUQNAA Notification Platform Scheduler (§53, §65)
    NotificationScheduler.get().start(30 * 1000);

    // Initialize Wishlist Background Alert Monitor
    WishlistAlertsJob.start(15);

    // Initialize Flash Sale Lifecycle & Reservation Monitor (Phase 40)
    FlashSaleScheduler.start(30 * 1000);

    // Initialize Two-Way Follow Notification & Counter Drift Scheduler
    FollowScheduler.start();

    // Initialize Promotional Campaign & Banner Engine (placements seeding & sync)
    // Defer initialization asynchronously to prevent cold-start delay before port binding (§1, §2)
    CampaignBannerScheduler.init().catch((err) => {
      console.warn('[CampaignBanner] Deferred init warning:', err?.message);
    });
    CampaignBannerScheduler.start(60 * 1000);

    // Initialize Recommendation Engine Scheduler & Workers (§20, §96)
    RecommendationJobs.initJobs();

    // Initialize SOUQNAA Coins & Rewards Expiration & Reconciliation Scheduler (§84, §85)
    RewardsScheduler.start(60 * 60 * 1000); // Hourly expiration & daily warning cycle

    // Initialize SOUQNA Cart Abandonment Reminder Engine
    CartAbandonmentJob.start(5);

    // Initialize SOUQNA Seller Financial Risk Reserve & Invariant Reconciliation Worker
    SellerReserveScheduler.start(60 * 60 * 1000); // Hourly check for 30-day mature releases

    server.listen(config.port, () => {
      console.log(`
🚀 سوقناا Backend API is running!
---------------------------------------------
🌍 Environment : ${config.env}
🔌 Port        : ${config.port}
🔗 API Base    : http://localhost:${config.port}${config.apiPrefix}
📡 WebSocket   : ws://localhost:${config.port}
🩺 Health Check: http://localhost:${config.port}/health
🚦 Readiness   : http://localhost:${config.port}/ready
📊 Telemetry   : http://localhost:${config.port}/telemetry/metrics
🌐 Cloudflare  : ${config.cloudflare.enabled ? 'Active/Proxied' : 'Direct'}
---------------------------------------------
      `);
    });

    // Graceful Shutdown & Connection Draining (§2)
    const shutdown = async (signal: string) => {
      console.log(`\nReceived ${signal}. Shutting down gracefully...`);
      NotificationScheduler.get().stop();
      WishlistAlertsJob.stop();
      FlashSaleScheduler.stop();
      FollowScheduler.stop();
      CampaignBannerScheduler.stop();
      RewardsScheduler.stop();
      CartAbandonmentJob.stop();
      SellerReserveScheduler.stop();

      // Drain WebSocket real-time connections
      try {
        await SocketService.get()?.close();
      } catch (wsErr: any) {
        console.warn('[Shutdown] Socket drain warning:', wsErr?.message);
      }

      // Close HTTP server with connection draining
      server.close(async () => {
        try {
          await redis.disconnect();
          await prisma.$disconnect();
          console.log('Database and Redis disconnected. Process terminated gracefully.');
          process.exit(0);
        } catch (dbErr: any) {
          console.error('[Shutdown] Disconnect error:', dbErr);
          process.exit(1);
        }
      });

      // Force exit if connections do not drain within 10 seconds
      setTimeout(() => {
        console.error('[Shutdown] Forceful termination after 10s timeout.');
        process.exit(1);
      }, 10000).unref();
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
};

// سوقناا — Promotional Engine & Mega Campaigns active
startServer();
