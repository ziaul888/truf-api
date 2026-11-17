import request from 'supertest';
import { PlatformCommands } from '../../src/platform/platform-command.js';
import { api, post, get, inputTurf, type GetBilling } from './billing-state.js';
export function onboardingCases(state: GetBilling) {
  it('requires platform access and a trusted browser origin for onboarding', async () => {
    const s = state(),
      body = inputTurf();
    await request(s.app.getHttpServer())
      .post(api + '/tenants')
      .send(body)
      .expect(401);
    await request(s.app.getHttpServer())
      .post(api + '/tenants')
      .set('Cookie', s.staffCookie)
      .send(body)
      .expect(401);
    await request(s.app.getHttpServer())
      .post(api + '/tenants')
      .set('Cookie', s.cookie)
      .set('Origin', 'https://evil.example')
      .send(body)
      .expect(403);
    expect(
      await s.db.tenant.findUnique({ where: { slug: body.slug } }),
    ).toBeNull();
  });
  it('creates a setup turf and a pending owner without exposing credentials', async () => {
    const s = state(),
      body = inputTurf();
    const response = await post(s, '/tenants', body).expect(201);
    expect(response.body.data).toMatchObject({
      slug: body.slug,
      status: 'draft',
      owner: { email: body.ownerEmail, isActive: false },
      activeStaffCount: 0,
    });
    const owner = await s.db.user.findUniqueOrThrow({
      where: { email: body.ownerEmail },
    });
    expect(owner.isActive).toBe(false);
    expect(owner.role).toBe('manager');
    expect(JSON.stringify(response.body)).not.toMatch(/password|token/i);
    await request(s.app.getHttpServer())
      .post('/api/v1/admin/auth/login')
      .send({ email: body.ownerEmail, password: 'not-the-password' })
      .expect(401);
  });
  it('keeps an existing owner identity and sign-in details unchanged', async () => {
    const s = state(),
      before = await s.db.user.findUniqueOrThrow({ where: { id: s.staffId } });
    const response = await post(s, '/tenants', {
      ...inputTurf(),
      ownerName: 'Do not rename existing staff',
      ownerEmail: before.email,
    }).expect(201);
    expect(response.body.data.owner.name).toBe(before.name);
    const after = await s.db.user.findUniqueOrThrow({
      where: { id: s.staffId },
    });
    expect(after.passwordHash).toBe(before.passwordHash);
    expect(after.role).toBe(before.role);
    expect(after.isActive).toBe(true);
    await post(s, '/tenants', {
      ...inputTurf(),
      ownerEmail: before.email,
    }).expect(409);
  });
  it('rejects reserved handles and duplicate slugs without orphaned owners', async () => {
    const s = state();
    await post(s, '/tenants', { ...inputTurf(), slug: 'manage' }).expect(400);
    const body = inputTurf();
    await post(s, '/tenants', body).expect(201);
    const another = inputTurf();
    await post(s, '/tenants', { ...another, slug: body.slug }).expect(409);
    expect(
      await s.db.user.findUnique({ where: { email: another.ownerEmail } }),
    ).toBeNull();
  });
  it('replays an unchanged request once and rejects changed input for the same request', async () => {
    const s = state(),
      body = inputTurf();
    const a = await post(s, '/tenants', body).expect(201);
    const b = await post(s, '/tenants', body).expect(201);
    expect(a.body.data.id).toBe(b.body.data.id);
    expect(
      await s.db.platformAuditEvent.count({
        where: { requestId: body.requestId },
      }),
    ).toBe(1);
    await post(s, '/tenants', { ...body, name: 'Changed name' }).expect(409);
  });
  it('enforces one turf per owner under concurrent onboarding', async () => {
    const s = state(),
      a = inputTurf(),
      b = { ...inputTurf(), ownerEmail: a.ownerEmail };
    const responses = await Promise.all([
      post(s, '/tenants', a),
      post(s, '/tenants', b),
    ]);
    expect(responses.map((r) => r.status).sort()).toEqual([201, 409]);
    const owner = await s.db.user.findUniqueOrThrow({
      where: { email: a.ownerEmail },
    });
    expect(
      await s.db.tenantMembership.count({
        where: { userId: owner.id, role: 'owner', isActive: true },
      }),
    ).toBe(1);
  });
  it('rechecks platform revocation inside the write transaction', async () => {
    const s = state(),
      commands = s.app.get(PlatformCommands),
      original = commands.run.bind(commands),
      body = inputTurf();
    const spy = vi
      .spyOn(commands, 'run')
      .mockImplementationOnce(async (actor, command, work) => {
        await s.db.platformGrant.update({
          where: { userId: s.adminId },
          data: { isActive: false },
        });
        try {
          return await original(actor, command, work);
        } finally {
          await s.db.platformGrant.update({
            where: { userId: s.adminId },
            data: { isActive: true, tokenVersion: { increment: 1 } },
          });
        }
      });
    try {
      await post(s, '/tenants', body).expect(403);
      expect(
        await s.db.tenant.findUnique({ where: { slug: body.slug } }),
      ).toBeNull();
      expect(
        await s.db.platformAuditEvent.findUnique({
          where: { requestId: body.requestId },
        }),
      ).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });
  it('audits the verified actor and ignores a supplied actor selector', async () => {
    const s = state(),
      body = inputTurf();
    const response = await post(s, '/tenants', {
      ...body,
      actorId: s.staffId,
    }).expect(201);
    const activity = await get(
      s,
      `/tenants/${response.body.data.id}/activity`,
    ).expect(200);
    expect(activity.body.data.data[0]).toMatchObject({
      action: 'tenant_created',
      actor: { id: s.adminId },
    });
    expect(activity.body.data.data[0]).not.toHaveProperty('inputHash');
    await post(s, '/tenants', { ...inputTurf(), requestId: 'invalid' }).expect(
      400,
    );
  });
}
