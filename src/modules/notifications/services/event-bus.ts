import { EventEmitter } from 'events';
import { DomainNotificationEvent } from '../notification.types';

export type NotificationEventHandler = (event: DomainNotificationEvent) => Promise<void> | void;

export class NotificationEventBus {
  private static instance: NotificationEventBus;
  private emitter = new EventEmitter();

  private constructor() {
    this.emitter.setMaxListeners(100);
  }

  static get(): NotificationEventBus {
    if (!NotificationEventBus.instance) {
      NotificationEventBus.instance = new NotificationEventBus();
    }
    return NotificationEventBus.instance;
  }

  /**
   * Publish a domain notification event asynchronously.
   * Business modules call this and return immediately without waiting for push dispatch.
   */
  publish(event: DomainNotificationEvent): void {
    setImmediate(() => {
      this.emitter.emit('notification:event', event);
      this.emitter.emit(`notification:${event.eventType}`, event);
      this.emitter.emit(`category:${event.category}`, event);
    });
  }

  subscribe(handler: NotificationEventHandler): void {
    this.emitter.on('notification:event', handler);
  }

  subscribeToType(eventType: string, handler: NotificationEventHandler): void {
    this.emitter.on(`notification:${eventType}`, handler);
  }

  unsubscribe(handler: NotificationEventHandler): void {
    this.emitter.off('notification:event', handler);
  }
}

export const notificationEventBus = NotificationEventBus.get();
