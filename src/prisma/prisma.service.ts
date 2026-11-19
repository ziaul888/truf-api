import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { env } from '../config/env.js';
import { PrismaClient } from '../generated/prisma/client.js';
import { dashboardData } from './dashboard-data-context.js';

/** Routes service queries to the authenticated turf database during tenant operations. */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  constructor() {
    super({ adapter: new PrismaPg({ connectionString: env.DATABASE_URL }) });
    return new Proxy(this, {
      get(publicClient, key, receiver) {
        const localClient = dashboardData.getStore()?.client;
        if (!localClient || key === 'then')
          return Reflect.get(publicClient, key, receiver);
        const value = Reflect.get(localClient, key, localClient);
        return typeof value === 'function' ? value.bind(localClient) : value;
      },
    });
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
