/**
 * RootWars realtime gateway.
 *
 * Every API instance subscribes to the Redis event channel and fans events out to
 * only the WebSocket clients it owns locally. Publishing happens once per event:
 * the originating instance delivers to its local clients immediately and marks the
 * event with its instance id; other instances deliver on receipt. Received events
 * are never republished, so no event loop is possible.
 *
 * Private channels (group / alliance / user) are authorised against current
 * membership at delivery time (short-TTL cache, `WS_MEMBERSHIP_CACHE_MS`), so a
 * client cannot keep receiving private events after it leaves a group/alliance.
 */

import crypto from 'node:crypto';
import { DatabaseAdapter } from '../db/index.js';
import { RedisClients } from '../db/redis.js';

export const REALTIME_EVENT_CHANNEL = 'rootwars:events';

export type RealtimeChannelType = 'global' | 'group' | 'alliance' | 'user';

export interface RealtimeEvent {
  type: string;
  channelType?: RealtimeChannelType;
  channelId?: string;
  payload: any;
  originInstanceId?: string;
}

export interface RealtimeSocket {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface RealtimeClient {
  socket: RealtimeSocket;
  userId: string;
  username: string;
}

export interface RealtimeGatewayOptions {
  /** Cache TTL for private-channel membership lookups, in ms. 0 disables caching. */
  membershipCacheMs?: number;
  instanceId?: string;
}

export class RealtimeGateway {
  private readonly clients = new Set<RealtimeClient>();
  private readonly membershipCache = new Map<string, { allowed: boolean; expiresAt: number }>();
  private readonly instanceId: string;
  private readonly membershipCacheMs: number;
  private subscribed = false;
  private onMessage?: (channel: string, message: string) => void;

  constructor(
    private readonly db: DatabaseAdapter,
    private readonly redis: RedisClients,
    options?: RealtimeGatewayOptions
  ) {
    this.instanceId = options?.instanceId ?? crypto.randomUUID();
    this.membershipCacheMs = options?.membershipCacheMs ?? Number(process.env.WS_MEMBERSHIP_CACHE_MS ?? 5000);
  }

  get id(): string {
    return this.instanceId;
  }

  get clientCount(): number {
    return this.clients.size;
  }

  async start(): Promise<void> {
    if (this.subscribed) return;
    this.onMessage = (channel: string, message: string) => {
      if (channel === REALTIME_EVENT_CHANNEL) {
        void this.handleRemoteEvent(message);
      }
    };
    this.redis.sub.on('message', this.onMessage);
    await this.redis.sub.subscribe(REALTIME_EVENT_CHANNEL);
    this.subscribed = true;
  }

  async stop(): Promise<void> {
    if (!this.subscribed) return;
    if (this.onMessage) {
      this.redis.sub.off('message', this.onMessage);
    }
    await this.redis.sub.unsubscribe(REALTIME_EVENT_CHANNEL).catch(() => {});
    this.subscribed = false;
    for (const client of this.clients) {
      try {
        client.socket.close(1001, 'Gateway shutting down');
      } catch {
        /* ignore */
      }
    }
    this.clients.clear();
  }

  addClient(client: RealtimeClient): void {
    this.clients.add(client);
  }

  removeClient(client: RealtimeClient): void {
    this.clients.delete(client);
  }

  /**
   * Publishes an event to Redis and delivers it locally. The event is delivered
   * exactly once per instance: the publisher handles its own local clients and
   * other instances deliver when the message arrives on the subscribed channel.
   */
  publish(event: RealtimeEvent): void {
    const stamped: RealtimeEvent = { ...event, originInstanceId: this.instanceId };
    const serialized = JSON.stringify(stamped);
    this.deliverLocal(serialized, stamped).catch(() => {});
    this.redis.pub.publish(REALTIME_EVENT_CHANNEL, serialized).catch(() => {});
  }

  /** Handles an event delivered by Redis (i.e. published by any instance). */
  private async handleRemoteEvent(message: string): Promise<void> {
    let event: RealtimeEvent;
    try {
      event = JSON.parse(message);
    } catch {
      return; // ignore malformed frames
    }
    if (event?.originInstanceId === this.instanceId) {
      return; // already delivered locally by publish(); never republish
    }
    await this.deliverLocal(message, event);
  }

  private async isAuthorizedForEvent(client: RealtimeClient, event: RealtimeEvent): Promise<boolean> {
    const channelType = event.channelType ?? 'global';
    if (channelType === 'global') return true;
    if (channelType === 'user') return client.userId === event.channelId;
    if (!event.channelId) return false;
    return this.isMemberOfChannel(client.userId, channelType, event.channelId);
  }

  private async isMemberOfChannel(
    userId: string,
    channelType: 'group' | 'alliance',
    channelId: string
  ): Promise<boolean> {
    const cacheKey = `${userId}:${channelType}:${channelId}`;
    if (this.membershipCacheMs > 0) {
      const cached = this.membershipCache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) {
        return cached.allowed;
      }
    }

    let allowed = false;
    try {
      if (channelType === 'group') {
        const res = await this.db.query(
          `SELECT 1 FROM group_members WHERE user_id = $1 AND group_id = $2`,
          [userId, channelId]
        );
        allowed = res.rows.length > 0;
      } else {
        const res = await this.db.query(
          `SELECT 1 FROM group_members gm
           JOIN groups g ON g.id = gm.group_id
           WHERE gm.user_id = $1 AND g.alliance_id = $2`,
          [userId, channelId]
        );
        allowed = res.rows.length > 0;
      }
    } catch {
      allowed = false; // fail closed on membership lookup errors
    }

    if (this.membershipCacheMs > 0) {
      this.membershipCache.set(cacheKey, {
        allowed,
        expiresAt: Date.now() + this.membershipCacheMs
      });
    }
    return allowed;
  }

  private async deliverLocal(serialized: string, event: RealtimeEvent): Promise<void> {
    for (const client of this.clients) {
      try {
        if (!(await this.isAuthorizedForEvent(client, event))) continue;
        if (client.socket.readyState === 1) {
          client.socket.send(serialized);
        }
      } catch {
        /* a single failing socket must never break fan-out */
      }
    }
  }

  /** Test/diagnostic helper: forces a membership cache flush. */
  clearMembershipCache(): void {
    this.membershipCache.clear();
  }
}
