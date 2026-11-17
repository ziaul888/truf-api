import request from 'supertest';
import type { GetPlatform } from './platform-state.js';
const root = '/api/v1/platform';
export function platformTenantCases(get: GetPlatform) {
  it('returns real lifecycle totals and active owner count', async () => {
    const { app, db, cookie } = get();
    const response = await request(app.getHttpServer())
      .get(root + '/overview')
      .set('Cookie', cookie)
      .expect(200);
    expect(response.body.data.counts.total).toBe(await db.tenant.count());
    for (const status of ['active', 'draft', 'suspended', 'archived'] as const)
      expect(response.body.data.counts[status]).toBe(
        await db.tenant.count({ where: { status } }),
      );
    expect(response.body.data.owners).toBe(
      await db.user.count({
        where: {
          isActive: true,
          tenantMemberships: { some: { role: 'owner', isActive: true } },
        },
      }),
    );
    expect(response.body.data.recentTenants.length).toBeLessThanOrEqual(6);
    expect(response.body.data).not.toHaveProperty('revenue');
  });
  it('lists all registered businesses only after platform authorization', async () => {
    const { app, cookie, fixtures } = get();
    const response = await request(app.getHttpServer())
      .get(root + '/tenants')
      .query({ search: 'platform-e2e-', limit: 2 })
      .set('Cookie', cookie)
      .expect(200)
      .expect('Cache-Control', 'private, no-store');
    expect(response.body.data).toMatchObject({ total: 3, page: 1, limit: 2 });
    const ids = response.body.data.data.map((row: { id: string }) => row.id);
    const next = await request(app.getHttpServer())
      .get(root + '/tenants')
      .query({ search: 'platform-e2e-', limit: 2, page: 2 })
      .set('Cookie', cookie)
      .expect(200);
    expect(next.body.data.data).toHaveLength(1);
    expect(ids).not.toContain(next.body.data.data[0].id);
    expect(new Set([...ids, next.body.data.data[0].id])).toEqual(
      new Set([fixtures.aId, fixtures.bId, fixtures.draftId]),
    );
  });
  it('filters lifecycle status and normalizes name/handle search', async () => {
    const { app, cookie, fixtures } = get();
    const response = await request(app.getHttpServer())
      .get(root + '/tenants')
      .query({ search: '  PLATFORM-E2E-  ', status: 'suspended' })
      .set('Cookie', cookie)
      .expect(200);
    expect(response.body.data).toMatchObject({
      total: 1,
      data: [{ id: fixtures.bId, status: 'suspended' }],
    });
    const empty = await request(app.getHttpServer())
      .get(root + '/tenants')
      .query({ search: 'no-such-platform-turf' })
      .set('Cookie', cookie)
      .expect(200);
    expect(empty.body.data).toMatchObject({ total: 0, data: [] });
  });
  it('returns a safe account DTO with owner and active staff count', async () => {
    const { app, cookie, fixtures } = get();
    const response = await request(app.getHttpServer())
      .get(root + `/tenants/${fixtures.aId}`)
      .set('Cookie', cookie)
      .expect(200);
    expect(response.body.data).toMatchObject({
      id: fixtures.aId,
      activeStaffCount: 1,
      owner: {
        id: fixtures.staffId,
        name: 'Turf Owner',
        email: 'staff@platform-e2e.test',
      },
    });
    expect(Object.keys(response.body.data).sort()).toEqual(
      [
        'id',
        'name',
        'slug',
        'status',
        'currency',
        'timezone',
        'createdAt',
        'updatedAt',
        'owner',
        'activeStaffCount',
      ].sort(),
    );
    expect(JSON.stringify(response.body)).not.toMatch(
      /passwordHash|tokenVersion|booking|payment/i,
    );
  });
  it('validates directory filters and tenant identifiers', async () => {
    const { app, cookie } = get();
    for (const query of [
      { page: 0 },
      { limit: 101 },
      { status: 'invalid' },
      { search: 'a'.repeat(101) },
    ])
      await request(app.getHttpServer())
        .get(root + '/tenants')
        .query(query)
        .set('Cookie', cookie)
        .expect(400);
    await request(app.getHttpServer())
      .get(root + '/tenants/invalid')
      .set('Cookie', cookie)
      .expect(400);
    await request(app.getHttpServer())
      .get(root + '/tenants/11111111-1111-4111-8111-111111111111')
      .set('Cookie', cookie)
      .expect(404);
  });
  it('does not count or expose a revoked owner membership', async () => {
    const { app, db, cookie, fixtures } = get();
    const where = {
      tenantId_userId: { tenantId: fixtures.aId, userId: fixtures.staffId },
    };
    await db.tenantMembership.update({ where, data: { isActive: false } });
    try {
      const response = await request(app.getHttpServer())
        .get(root + `/tenants/${fixtures.aId}`)
        .set('Cookie', cookie)
        .expect(200);
      expect(response.body.data).toMatchObject({
        owner: null,
        activeStaffCount: 0,
      });
    } finally {
      await db.tenantMembership.update({ where, data: { isActive: true } });
    }
  });
}
