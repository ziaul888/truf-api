import request from 'supertest';
import type { GetProof } from './proof-state.js';

const url = '/api/v1/admin/me/tenant';

export function singleTurfAccountCases(get: GetProof) {
  describe('single-turf account', () => {
    it('requires staff authentication', async () => {
      await request(get().app.getHttpServer()).get(url).expect(401);
    });

    it('resolves the current user turf and ignores supplied identity selectors', async () => {
      const {
        app,
        fixtures: { a, b },
        cookies,
      } = get();
      const response = await request(app.getHttpServer())
        .get(url)
        .query({ tenantId: b.tenantId, userId: b.userId })
        .set('Cookie', cookies.a)
        .expect('Cache-Control', 'private, no-store')
        .expect(200);
      expect(response.body.data).toMatchObject({
        id: a.tenantId,
        role: 'owner',
      });
      expect(response.body.data).not.toHaveProperty('passwordHash');
      const manager = await request(app.getHttpServer())
        .get(url)
        .set('Cookie', cookies.manager)
        .expect(200);
      expect(manager.body.data).toMatchObject({
        id: a.tenantId,
        role: 'manager',
      });
    });

    it('does not give an unassigned global admin a default turf', async () => {
      const { app, cookies } = get();
      const response = await request(app.getHttpServer())
        .get(url)
        .set('Cookie', cookies.outsider)
        .expect(404);
      expect(response.body.code).toBe('TENANT_ACCOUNT_NOT_ASSIGNED');
      expect(response.body).not.toHaveProperty('data');
    });

    it('rejects ambiguous assignments rather than selecting the first turf', async () => {
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
        const response = await request(app.getHttpServer())
          .get(url)
          .set('Cookie', cookies.a)
          .expect(409);
        expect(response.body.code).toBe('TENANT_ACCOUNT_AMBIGUOUS');
        expect(response.body).not.toHaveProperty('data');
      } finally {
        await db.admin.tenantMembership.delete({ where });
      }
    });

    it('does not resolve a revoked membership', async () => {
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
          .get(url)
          .set('Cookie', cookies.a)
          .expect(404);
        expect(response.body.code).toBe('TENANT_ACCOUNT_NOT_ASSIGNED');
      } finally {
        await db.admin.tenantMembership.update({
          where,
          data: { isActive: true },
        });
      }
    });

    it('shows paused account metadata without granting operational access', async () => {
      const {
        app,
        db,
        fixtures: { a },
        cookies,
      } = get();
      await db.admin.tenant.update({
        where: { id: a.tenantId },
        data: { status: 'suspended' },
      });
      try {
        const response = await request(app.getHttpServer())
          .get(url)
          .set('Cookie', cookies.a)
          .expect(200);
        expect(response.body.data).toMatchObject({
          id: a.tenantId,
          status: 'suspended',
        });
        await request(app.getHttpServer())
          .get(`/api/v1/tenants/${a.tenantId}/profile`)
          .set('Cookie', cookies.a)
          .expect(403);
      } finally {
        await db.admin.tenant.update({
          where: { id: a.tenantId },
          data: { status: 'active' },
        });
      }
    });
  });
}
