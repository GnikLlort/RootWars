import { Redis } from 'ioredis';
import RedisMock from 'ioredis-mock';

export interface RedisClients {
  client: Redis;
  pub: Redis;
  sub: Redis;
  backendType: 'redis' | 'redis-mock';
  close(): Promise<void>;
}

let activeRedis: RedisClients | null = null;

export async function createRedisClients(redisUrl?: string): Promise<RedisClients> {
  const url = redisUrl ?? process.env.REDIS_URL;

  if (url && process.env.FORCE_REDIS_MOCK !== 'true') {
    try {
      const client = new Redis(url, {
        connectTimeout: 1200,
        maxRetriesPerRequest: 1,
        retryStrategy: () => null,
        lazyConnect: true
      });
      client.on('error', () => {});
      await client.connect();
      await client.ping();

      const pub = client.duplicate();
      const sub = client.duplicate();
      pub.on('error', () => {});
      sub.on('error', () => {});
      await pub.connect();
      await sub.connect();

      return {
        client,
        pub,
        sub,
        backendType: 'redis',
        close: async () => {
          await Promise.allSettled([client.quit(), pub.quit(), sub.quit()]);
        }
      };
    } catch {
      // Fallback to embedded ioredis-mock
    }
  }

  const MockCtor = (RedisMock as unknown as { default?: typeof RedisMock }).default ?? RedisMock;
  const client = new (MockCtor as any)() as Redis;
  const pub = (client as any).createConnectedClient ? (client as any).createConnectedClient() : new (MockCtor as any)();
  const sub = (client as any).createConnectedClient ? (client as any).createConnectedClient() : new (MockCtor as any)();

  return {
    client,
    pub,
    sub,
    backendType: 'redis-mock',
    close: async () => {
      await Promise.allSettled([client.quit(), pub.quit(), sub.quit()]);
    }
  };
}

export async function getRedis(): Promise<RedisClients> {
  if (!activeRedis) {
    activeRedis = await createRedisClients();
  }
  return activeRedis;
}

export function setRedis(clients: RedisClients | null): void {
  activeRedis = clients;
}
