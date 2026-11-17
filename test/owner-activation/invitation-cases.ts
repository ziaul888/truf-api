import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { verifyPassword } from '../../src/auth/password.js';
import {
  createInvitation,
  preview,
  accept,
  platformPost,
  platformGet,
  turfInput,
  type GetOwnerState,
} from './state.js';
export function invitationCases(state: GetOwnerState) {
  it('limits invitation issuance to platform access and a trusted browser origin', async () => {
    const s = state(),
      turf = (await platformPost(s, '/tenants', turfInput()).expect(201)).body
        .data,
      path = `/api/v1/platform/tenants/${turf.id}/owner-invitation`;
    await request(s.app.getHttpServer())
      .post(path)
      .send({ requestId: randomUUID() })
      .expect(401);
    await request(s.app.getHttpServer())
      .post(path)
      .set('Cookie', s.staffCookie)
      .send({ requestId: randomUUID() })
      .expect(401);
    await request(s.app.getHttpServer())
      .post(path)
      .set('Cookie', s.platformCookie)
      .set('Origin', 'https://evil.example')
      .send({ requestId: randomUUID() })
      .expect(403);
  });
  it('stores only a token hash, expires in 24 hours and replays an unchanged issuance safely', async () => {
    const s = state(),
      a = await createInvitation(s),
      row = await s.db.ownerInvitation.findUniqueOrThrow({
        where: { id: a.invitation.invitationId },
      });
    expect(a.invitation.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(row.tokenHash).not.toBe(a.invitation.token);
    expect(row.expiresAt.getTime() - row.createdAt.getTime()).toBeGreaterThan(
      23 * 3600000,
    );
    const replay = await platformPost(
      s,
      `/tenants/${a.turf.id}/owner-invitation`,
      a.body,
    ).expect(201);
    expect(replay.body.data.token).toBe(a.invitation.token);
    expect(
      await s.db.ownerInvitation.count({
        where: { membershipId: row.membershipId },
      }),
    ).toBe(1);
    const activity = await platformGet(
      s,
      `/tenants/${a.turf.id}/activity`,
    ).expect(200);
    expect(JSON.stringify(activity.body)).not.toContain(a.invitation.token);
    expect(JSON.stringify(activity.body)).not.toContain(row.tokenHash);
    const p = await preview(s, a.invitation.token).expect(200);
    expect(p.headers['cache-control']).toBe('private, no-store');
    expect(p.body.data).toMatchObject({
      email: a.input.ownerEmail,
      turfName: a.turf.name,
    });
  });
  it('invalidates an old link when the administrator creates a replacement', async () => {
    const s = state(),
      a = await createInvitation(s),
      next = await platformPost(s, `/tenants/${a.turf.id}/owner-invitation`, {
        requestId: randomUUID(),
      }).expect(201);
    expect(next.body.data.token).not.toBe(a.invitation.token);
    await preview(s, a.invitation.token).expect(400);
    await preview(s, next.body.data.token).expect(200);
    const replay = await platformPost(
      s,
      `/tenants/${a.turf.id}/owner-invitation`,
      a.body,
    ).expect(201);
    expect(replay.body.data.token).toBeNull();
  });
  it('activates the owner once, hashes their chosen password and leaves the turf in setup', async () => {
    const s = state(),
      a = await createInvitation(s),
      response = await accept(s, a.invitation.token).expect(200);
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(response.body.data.activated).toBe(true);
    const user = await s.db.user.findUniqueOrThrow({
      where: { email: a.input.ownerEmail },
    });
    expect(user.isActive).toBe(true);
    expect(user.legacyStaffAccess).toBe(false);
    expect(
      await verifyPassword('owner-chosen-password-123', user.passwordHash),
    ).toBe(true);
    expect(
      (await s.db.tenant.findUniqueOrThrow({ where: { id: a.turf.id } }))
        .status,
    ).toBe('draft');
    await accept(
      s,
      a.invitation.token,
      'a-new-password-that-must-not-win',
    ).expect(400);
    expect(
      (await platformGet(s, `/tenants/${a.turf.id}/owner-access`).expect(200))
        .body.data,
    ).toMatchObject({ status: 'active', canInvite: false });
    expect(
      await s.db.platformAuditEvent.count({
        where: { tenantId: a.turf.id, action: 'owner_activated' },
      }),
    ).toBe(1);
  });
  it('allows only one password to win concurrent activation', async () => {
    const s = state(),
      a = await createInvitation(s),
      passwords = ['first-owner-password-123', 'second-owner-password-123'];
    const results = await Promise.all(
      passwords.map((password) => accept(s, a.invitation.token, password)),
    );
    expect(results.map((r) => r.status).sort()).toEqual([200, 400]);
    const user = await s.db.user.findUniqueOrThrow({
      where: { email: a.input.ownerEmail },
    });
    const winner = results.findIndex((r) => r.status === 200);
    expect(await verifyPassword(passwords[winner]!, user.passwordHash)).toBe(
      true,
    );
    expect(
      await verifyPassword(passwords[1 - winner]!, user.passwordHash),
    ).toBe(false);
  });
  it.each([
    'expired',
    'revoked',
    'membership-revoked',
    'identity-revoked',
    'turf-paused',
  ] as const)('rejects a %s link', async (kind) => {
    const s = state(),
      a = await createInvitation(s),
      row = await s.db.ownerInvitation.findUniqueOrThrow({
        where: { id: a.invitation.invitationId },
      });
    if (kind === 'expired')
      await s.db.ownerInvitation.update({
        where: { id: row.id },
        data: { expiresAt: new Date(0) },
      });
    if (kind === 'revoked')
      await s.db.ownerInvitation.update({
        where: { id: row.id },
        data: { revokedAt: new Date() },
      });
    if (kind === 'membership-revoked')
      await s.db.tenantMembership.update({
        where: { id: row.membershipId },
        data: { isActive: false },
      });
    if (kind === 'identity-revoked')
      await s.db.user.update({
        where: { id: row.userId },
        data: { tokenVersion: { increment: 1 } },
      });
    if (kind === 'turf-paused')
      await s.db.tenant.update({
        where: { id: a.turf.id },
        data: { status: 'suspended' },
      });
    await preview(s, a.invitation.token).expect(400);
    await accept(s, a.invitation.token).expect(400);
  });
  it('rejects weak passwords, missing capabilities and hostile activation origins', async () => {
    const s = state(),
      a = await createInvitation(s);
    await accept(s, a.invitation.token, 'short').expect(400);
    await preview(s, 'invalid').expect(400);
    await request(s.app.getHttpServer())
      .post('/api/v1/owner/activation/accept')
      .set('Origin', 'https://evil.example')
      .send({
        token: a.invitation.token,
        password: 'owner-chosen-password-123',
      })
      .expect(403);
    expect(
      (
        await s.db.ownerInvitation.findUniqueOrThrow({
          where: { id: a.invitation.invitationId },
        })
      ).consumedAt,
    ).toBeNull();
  });
  it('preserves an existing active staff account and refuses password-reset invitations for it', async () => {
    const s = state(),
      before = await s.db.user.findUniqueOrThrow({ where: { id: s.staffId } });
    const turf = (
      await platformPost(s, '/tenants', {
        ...turfInput(),
        ownerEmail: before.email,
      }).expect(201)
    ).body.data;
    await platformPost(s, `/tenants/${turf.id}/owner-invitation`, {
      requestId: randomUUID(),
    }).expect(409);
    const after = await s.db.user.findUniqueOrThrow({
      where: { id: s.staffId },
    });
    expect(after.passwordHash).toBe(before.passwordHash);
    expect(after.legacyStaffAccess).toBe(true);
  });
  it('refuses to reinterpret existing inactive staff identities as new owner accounts', async () => {
    const s = state(),
      a = await createInvitation(s);
    await s.db.ownerInvitation.delete({
      where: { id: a.invitation.invitationId },
    });
    await s.db.user.update({
      where: { email: a.input.ownerEmail },
      data: { legacyStaffAccess: true },
    });
    await platformPost(s, `/tenants/${a.turf.id}/owner-invitation`, {
      requestId: randomUUID(),
    }).expect(409);
    const old = await s.db.user.create({
      data: {
        name: 'Unrelated inactive staff',
        email: 'old@owner-activation-e2e.test',
        passwordHash: 'not-a-sign-in-hash',
        isActive: false,
        createdAt: new Date('2020-01-01'),
      },
    });
    const turf = (
      await platformPost(s, '/tenants', {
        ...turfInput(),
        ownerEmail: old.email,
      }).expect(201)
    ).body.data;
    await platformPost(s, `/tenants/${turf.id}/owner-invitation`, {
      requestId: randomUUID(),
    }).expect(409);
    expect(
      (await s.db.user.findUniqueOrThrow({ where: { id: old.id } }))
        .legacyStaffAccess,
    ).toBe(true);
  });
}
