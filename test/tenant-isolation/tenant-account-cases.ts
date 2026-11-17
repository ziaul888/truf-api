import request from 'supertest';
import type { GetProof } from './proof-state.js';

const listUrl = '/api/v1/admin/me/tenants';
const profileUrl = (id: string) => `/api/v1/tenants/${id}/profile`;

export function tenantAccountCases(get: GetProof) {
  describe('read-only business accounts API', () => {
    it('requires authentication for both endpoints', async () => {
      const {
        app,
        fixtures: { a },
      } = get();
      await request(app.getHttpServer()).get(listUrl).expect(401);
      await request(app.getHttpServer())
        .get(profileUrl(a.tenantId))
        .expect(401);
    });

    it('returns only the current staff member memberships with a minimal DTO', async () => {
      const {
        app,
        fixtures: { a },
        cookies,
      } = get();
      const { body } = await request(app.getHttpServer())
        .get(listUrl)
        .set('Cookie', cookies.a)
        .expect('Cache-Control', 'private, no-store')
        .expect(200);
      expect(body.data).toMatchObject({ total: 1, page: 1, limit: 20 });
      expect(body.data.data[0]).toMatchObject({
        id: a.tenantId,
        slug: 'tenant-proof-a',
        role: 'owner',
        status: 'active',
        timezone: 'Asia/Dhaka',
        currency: 'bdt',
      });
      expect(Object.keys(body.data.data[0]).sort()).toEqual(
        [
          'id',
          'slug',
          'name',
          'role',
          'status',
          'timezone',
          'currency',
          'createdAt',
          'joinedAt',
        ].sort(),
      );
    });

    it('does not elevate a global admin or accept a supplied user selector', async () => {
      const {
        app,
        fixtures: { b },
        cookies,
      } = get();
      const response = await request(app.getHttpServer())
        .get(listUrl)
        .set('Cookie', cookies.outsider)
        .query({ userId: b.userId, tenantId: b.tenantId })
        .expect(200);
      expect(response.body.data).toMatchObject({ total: 0, data: [] });
    });

    it('checks profile membership and returns membership role', async () => {
      const {
        app,
        fixtures: { a, b },
        cookies,
      } = get();
      const response = await request(app.getHttpServer())
        .get(profileUrl(a.tenantId))
        .set('Cookie', cookies.manager)
        .expect('Cache-Control', 'private, no-store')
        .expect(200);
      expect(response.body.data).toMatchObject({
        id: a.tenantId,
        role: 'manager',
      });
      await request(app.getHttpServer())
        .get(profileUrl(b.tenantId))
        .set('Cookie', cookies.a)
        .expect(403);
      await request(app.getHttpServer())
        .get(profileUrl('invalid'))
        .set('Cookie', cookies.a)
        .expect(400);
    });

    it('scopes search, pagination and status filters to membership', async () => {
      const {
        app,
        db,
        fixtures: { a, b },
        cookies,
      } = get();
      const where = {
        tenantId_userId: { tenantId: b.tenantId, userId: a.userId },
      };
      await db.admin.tenantMembership.create({
        data: { tenantId: b.tenantId, userId: a.userId, role: 'manager' },
      });
      try {
        const page1 = await request(app.getHttpServer())
          .get(listUrl)
          .set('Cookie', cookies.a)
          .query({ limit: 1 })
          .expect(200);
        const page2 = await request(app.getHttpServer())
          .get(listUrl)
          .set('Cookie', cookies.a)
          .query({ limit: 1, page: 2 })
          .expect(200);
        expect(page1.body.data.total).toBe(2);
        expect(page1.body.data.data[0].id).not.toBe(page2.body.data.data[0].id);
        const search = await request(app.getHttpServer())
          .get(listUrl)
          .set('Cookie', cookies.a)
          .query({ search: '  TENANT-PROOF-B  ' })
          .expect(200);
        expect(search.body.data.data).toEqual([
          expect.objectContaining({ id: b.tenantId }),
        ]);
        await db.admin.tenant.update({
          where: { id: b.tenantId },
          data: { status: 'suspended' },
        });
        const paused = await request(app.getHttpServer())
          .get(listUrl)
          .set('Cookie', cookies.a)
          .query({ status: 'suspended' })
          .expect(200);
        expect(paused.body.data.data).toEqual([
          expect.objectContaining({ id: b.tenantId, status: 'suspended' }),
        ]);
        await request(app.getHttpServer())
          .get(profileUrl(b.tenantId))
          .set('Cookie', cookies.a)
          .expect(403);
      } finally {
        await db.admin.tenant.update({
          where: { id: b.tenantId },
          data: { status: 'active' },
        });
        await db.admin.tenantMembership.delete({ where });
      }
    });

    it('removes revoked memberships from the list and profile', async () => {
      const {
        app,
        db,
        fixtures: { a },
        cookies,
      } = get();
      const where = {
        tenantId_userId: { tenantId: a.tenantId, userId: a.userId },
      };
      await db.admin.tenantMembership.update({
        where,
        data: { isActive: false },
      });
      try {
        const response = await request(app.getHttpServer())
          .get(listUrl)
          .set('Cookie', cookies.a)
          .expect(200);
        expect(response.body.data).toMatchObject({ total: 0, data: [] });
        await request(app.getHttpServer())
          .get(profileUrl(a.tenantId))
          .set('Cookie', cookies.a)
          .expect(403);
      } finally {
        await db.admin.tenantMembership.update({
          where,
          data: { isActive: true },
        });
      }
    });

    it('rejects invalid filters', async () => {
      const { app, cookies } = get();
      for (const query of [
        { page: 0 },
        { limit: 101 },
        { status: 'unknown' },
        { search: 'x'.repeat(101) },
      ]) {
        await request(app.getHttpServer())
          .get(listUrl)
          .set('Cookie', cookies.a)
          .query(query)
          .expect(400);
      }
    });
  });
}
