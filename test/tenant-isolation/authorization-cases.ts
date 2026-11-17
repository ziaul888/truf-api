import request from 'supertest';
import { freshSlots } from './proof-fixtures.js';
import type { GetProof } from './proof-state.js';

const url = (tenantId: string) => `/api/v1/tenants/${tenantId}/proof`;

export function authorizationCases(get: GetProof) {
  describe('staff HTTP authorization', () => {
    it('requires authentication and validates the tenant identifier', async () => {
      const {
        app,
        fixtures: { a },
        cookies,
      } = get();
      await request(app.getHttpServer())
        .get(`${url(a.tenantId)}/grounds`)
        .expect(401);
      await request(app.getHttpServer())
        .get(`${url('invalid')}/grounds`)
        .set('Cookie', cookies.a)
        .expect(400);
    });

    it('returns only the member business, even when client headers claim another one', async () => {
      const {
        app,
        fixtures: { a, b },
        cookies,
      } = get();
      const response = await request(app.getHttpServer())
        .get(`${url(a.tenantId)}/grounds`)
        .set('Cookie', cookies.a)
        .set('X-Tenant-Id', b.tenantId)
        .expect(200);
      expect(response.body.data).toEqual([
        expect.objectContaining({ id: a.groundId, tenantId: a.tenantId }),
      ]);
      await request(app.getHttpServer())
        .get(`${url(b.tenantId)}/grounds`)
        .set('Cookie', cookies.a)
        .set('X-Tenant-Role', 'owner')
        .expect(403);
    });

    it('does not grant business membership to an unrelated global admin', async () => {
      const {
        app,
        fixtures: { a },
        cookies,
      } = get();
      await request(app.getHttpServer())
        .get(`${url(a.tenantId)}/grounds`)
        .set('Cookie', cookies.outsider)
        .expect(403);
    });

    it('uses membership role, not the old global admin role, for owner actions', async () => {
      const {
        app,
        fixtures: { a },
        cookies,
      } = get();
      await request(app.getHttpServer())
        .patch(`${url(a.tenantId)}/grounds/${a.groundId}`)
        .set('Cookie', cookies.manager)
        .expect(403);
      await request(app.getHttpServer())
        .patch(`${url(a.tenantId)}/grounds/${a.groundId}`)
        .set('Cookie', cookies.a)
        .expect(200);
    });

    it('cannot modify another business by replacing a resource identifier', async () => {
      const {
        app,
        db,
        fixtures: { a, b },
        cookies,
      } = get();
      const before = await db.fixture.ground.findUniqueOrThrow({
        where: { id: b.groundId },
      });
      const response = await request(app.getHttpServer())
        .patch(`${url(a.tenantId)}/grounds/${b.groundId}`)
        .set('Cookie', cookies.a)
        .expect(200);
      expect(response.body.data.count).toBe(0);
      expect(
        await db.fixture.ground.findUniqueOrThrow({
          where: { id: b.groundId },
        }),
      ).toEqual(before);
    });

    it('refuses a reservation for foreign slots and accepts an owned one', async () => {
      const {
        app,
        db,
        fixtures: { a, b },
        cookies,
      } = get();
      const foreign = await freshSlots(db, b, 1),
        own = await freshSlots(db, a, 1);
      await request(app.getHttpServer())
        .post(`${url(a.tenantId)}/reservations`)
        .set('Cookie', cookies.a)
        .send({ slotIds: [foreign[0].id] })
        .expect(409);
      const response = await request(app.getHttpServer())
        .post(`${url(a.tenantId)}/reservations`)
        .set('Cookie', cookies.a)
        .send({ slotIds: [own[0].id] })
        .expect(201);
      expect(response.body.data).toMatchObject({
        tenantId: a.tenantId,
        slotId: own[0].id,
      });
      expect(
        await db.fixture.slot.findUniqueOrThrow({
          where: { id: foreign[0].id },
        }),
      ).toMatchObject({ status: 'available' });
    });

    it('rejects a removed membership on the next request', async () => {
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
        await request(app.getHttpServer())
          .get(`${url(a.tenantId)}/grounds`)
          .set('Cookie', cookies.a)
          .expect(403);
      } finally {
        await db.admin.tenantMembership.update({
          where,
          data: { isActive: true },
        });
      }
    });

    it('rejects an inactive tenant without changing another business', async () => {
      const {
        app,
        db,
        fixtures: { a, b },
        cookies,
      } = get();
      await db.admin.tenant.update({
        where: { id: a.tenantId },
        data: { status: 'suspended' },
      });
      try {
        await request(app.getHttpServer())
          .get(`${url(a.tenantId)}/grounds`)
          .set('Cookie', cookies.a)
          .expect(403);
        await request(app.getHttpServer())
          .get(`${url(b.tenantId)}/grounds`)
          .set('Cookie', cookies.b)
          .expect(200);
      } finally {
        await db.admin.tenant.update({
          where: { id: a.tenantId },
          data: { status: 'active' },
        });
      }
    });
  });
}
