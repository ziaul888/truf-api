import request from 'supertest';
import { JwtService } from '@nestjs/jwt';
import { env } from '../../src/config/env.js';
import { activateOwner, signIn, type GetOwnerState } from './state.js';
export function sessionCases(state: GetOwnerState) {
  it('uses an owner-only cookie and returns only the authenticated owner account', async () => {
    const s = state(),
      a = await activateOwner(s);
    expect(a.login.body.data).toMatchObject({
      audience: 'owner',
      role: 'owner',
      tenant: { id: a.turf.id },
    });
    expect(a.login.headers['set-cookie']?.[0]).toMatch(
      /^owner_token=.+;.*HttpOnly; SameSite=Lax$/,
    );
    expect(a.login.headers['set-cookie']?.[1]).toMatch(/^admin_token=;/);
    const me = await request(s.app.getHttpServer())
      .get('/api/v1/owner/auth/me')
      .set('Cookie', a.cookie)
      .expect(200);
    expect(me.headers['cache-control']).toBe('private, no-store');
    expect(JSON.stringify(me.body)).not.toMatch(
      /password|tokenVersion|legacyStaffAccess/,
    );
  });
  it('cannot use owner sessions or credentials to cross into staff or platform APIs', async () => {
    const s = state(),
      a = await activateOwner(s),
      raw = a.cookie.slice('owner_token='.length);
    for (const path of [
      '/admin/auth/me',
      '/admin/bookings',
      '/admin/grounds',
      '/admin/settings/venue',
      '/platform/overview',
    ])
      await request(s.app.getHttpServer())
        .get('/api/v1' + path)
        .set('Cookie', a.cookie)
        .expect(401);
    await request(s.app.getHttpServer())
      .get('/api/v1/admin/auth/me')
      .set('Cookie', 'admin_token=' + raw)
      .expect(401);
    await request(s.app.getHttpServer())
      .get('/api/v1/platform/auth/me')
      .set('Cookie', 'platform_token=' + raw)
      .expect(401);
    await request(s.app.getHttpServer())
      .get('/api/v1/owner/auth/me')
      .set(
        'Cookie',
        'owner_token=' + s.staffCookie.slice('admin_token='.length),
      )
      .expect(401);
    await request(s.app.getHttpServer())
      .get('/api/v1/owner/auth/me')
      .set(
        'Cookie',
        'owner_token=' + s.platformCookie.slice('platform_token='.length),
      )
      .expect(401);
    await request(s.app.getHttpServer())
      .post('/api/v1/platform/auth/login')
      .send({
        email: a.input.ownerEmail,
        password: 'owner-chosen-password-123',
      })
      .expect(403);
    const user = await s.db.user.findUniqueOrThrow({
      where: { email: a.input.ownerEmail },
    });
    const forgedStaff = await new JwtService({
      secret: env.JWT_SECRET,
    }).signAsync({ sub: user.id, role: 'admin', ver: user.tokenVersion });
    await request(s.app.getHttpServer())
      .get('/api/v1/admin/auth/me')
      .set('Cookie', 'admin_token=' + forgedStaff)
      .expect(401);
  });
  it.each([
    'membership',
    'role',
    'membership-version',
    'user',
    'user-version',
    'archive',
  ] as const)('revokes owner access after a %s change', async (kind) => {
    const s = state(),
      a = await activateOwner(s),
      invitation = await s.db.ownerInvitation.findUniqueOrThrow({
        where: { id: a.invitation.invitationId },
      });
    if (kind === 'membership')
      await s.db.tenantMembership.update({
        where: { id: invitation.membershipId },
        data: { isActive: false },
      });
    if (kind === 'role')
      await s.db.tenantMembership.update({
        where: { id: invitation.membershipId },
        data: { role: 'manager' },
      });
    if (kind === 'membership-version')
      await s.db.tenantMembership.update({
        where: { id: invitation.membershipId },
        data: { tokenVersion: { increment: 1 } },
      });
    if (kind === 'user')
      await s.db.user.update({
        where: { id: invitation.userId },
        data: { isActive: false },
      });
    if (kind === 'user-version')
      await s.db.user.update({
        where: { id: invitation.userId },
        data: { tokenVersion: { increment: 1 } },
      });
    if (kind === 'archive')
      await s.db.tenant.update({
        where: { id: a.turf.id },
        data: { status: 'archived' },
      });
    await request(s.app.getHttpServer())
      .get('/api/v1/owner/auth/me')
      .set('Cookie', a.cookie)
      .expect(401);
    await request(s.app.getHttpServer())
      .get('/api/v1/owner/billing')
      .set('Cookie', a.cookie)
      .expect(401);
  });
  it('allows a paused turf to read its own billing without any booking access', async () => {
    const s = state(),
      a = await activateOwner(s);
    await s.db.tenant.update({
      where: { id: a.turf.id },
      data: { status: 'suspended' },
    });
    await signIn(s, a.input.ownerEmail).expect(200);
    await request(s.app.getHttpServer())
      .get('/api/v1/owner/billing')
      .set('Cookie', a.cookie)
      .expect(200);
  });
  it('logs out owner sessions while preserving independent staff and platform sessions', async () => {
    const s = state(),
      a = await activateOwner(s),
      user = await s.db.user.findUniqueOrThrow({
        where: { email: a.input.ownerEmail },
      });
    await request(s.app.getHttpServer())
      .post('/api/v1/owner/auth/logout')
      .set('Cookie', a.cookie)
      .expect(200);
    await request(s.app.getHttpServer())
      .get('/api/v1/owner/auth/me')
      .set('Cookie', a.cookie)
      .expect(401);
    await request(s.app.getHttpServer())
      .get('/api/v1/admin/auth/me')
      .set('Cookie', s.staffCookie)
      .expect(200);
    await request(s.app.getHttpServer())
      .get('/api/v1/platform/auth/me')
      .set('Cookie', s.platformCookie)
      .expect(200);
    expect(
      (await s.db.user.findUniqueOrThrow({ where: { id: user.id } }))
        .tokenVersion,
    ).toBe(user.tokenVersion);
  });
}
