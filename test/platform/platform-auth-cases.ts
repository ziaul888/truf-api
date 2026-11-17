import request from 'supertest';
import { JwtService } from '@nestjs/jwt';
import { AuthService } from '../../src/auth/auth.service.js';
import { env } from '../../src/config/env.js';
import {
  PLATFORM_AUDIENCE,
  PLATFORM_ISSUER,
  platformJwtSecret,
} from '../../src/platform/platform-session.js';
import {
  platformLogin,
  staffLogin,
  type GetPlatform,
} from './platform-state.js';
const root = '/api/v1/platform';
export function platformAuthCases(get: GetPlatform) {
  it('logs in with a separate private cookie and minimal platform identity', async () => {
    const { app, fixtures } = get();
    const res = await request(app.getHttpServer())
      .post(root + '/auth/login')
      .send(platformLogin)
      .expect(200)
      .expect('Cache-Control', 'private, no-store');
    expect(res.body.data).toEqual({
      id: fixtures.userId,
      name: 'Platform Admin',
      email: platformLogin.email,
      role: 'platform_admin',
    });
    expect(res.headers['set-cookie'][0]).toMatch(
      /^platform_token=.+; Max-Age=28800; Path=\/; Expires=.+; HttpOnly; SameSite=Lax$/,
    );
    expect(JSON.stringify(res.body)).not.toMatch(/password|token|grant/i);
  });
  it('requires platform authentication on every data endpoint', async () => {
    const { app, fixtures } = get();
    for (const path of [
      '/auth/me',
      '/overview',
      '/tenants',
      `/tenants/${fixtures.aId}`,
    ])
      await request(app.getHttpServer())
        .get(root + path)
        .expect(401)
        .expect('Cache-Control', 'private, no-store');
  });
  it('does not promote a turf owner/global admin to platform administrator', async () => {
    const { app, staffCookie } = get();
    await request(app.getHttpServer())
      .post(root + '/auth/login')
      .send(staffLogin)
      .expect(403);
    await request(app.getHttpServer())
      .get(root + '/overview')
      .set('Cookie', staffCookie)
      .expect(401);
  });
  it('rejects wrong credentials and invalid login input', async () => {
    const { app } = get();
    await request(app.getHttpServer())
      .post(root + '/auth/login')
      .send({ ...platformLogin, password: 'wrong' })
      .expect(401);
    await request(app.getHttpServer())
      .post(root + '/auth/login')
      .send({ email: 'bad' })
      .expect(400);
  });
  it('rejects tokens renamed between the platform and staff audiences', async () => {
    const { app, cookie, staffCookie } = get();
    await request(app.getHttpServer())
      .get('/api/v1/admin/auth/me')
      .set('Cookie', cookie.replace('platform_token=', 'admin_token='))
      .expect(401);
    await request(app.getHttpServer())
      .get(root + '/overview')
      .set('Cookie', staffCookie.replace('admin_token=', 'platform_token='))
      .expect(401);
  });
  it('checks issuer, audience and claim shape even for a correctly signed token', async () => {
    const { app, db, fixtures } = get();
    const grant = await db.platformGrant.findUniqueOrThrow({
      where: { userId: fixtures.userId },
      include: { user: true },
    });
    const jwt = new JwtService({ secret: platformJwtSecret });
    const base = {
      sub: fixtures.userId,
      gid: grant.id,
      ver: grant.tokenVersion,
      uv: grant.user.tokenVersion,
      aud: PLATFORM_AUDIENCE,
      iss: PLATFORM_ISSUER,
    };
    for (const change of [
      { aud: 'staff' },
      { iss: 'wrong' },
      { sub: 'invalid' },
      { ver: -1 },
    ]) {
      const token = await jwt.signAsync({ ...base, ...change });
      await request(app.getHttpServer())
        .get(root + '/auth/me')
        .set('Cookie', `platform_token=${token}`)
        .expect(401);
    }
  });
  it('rechecks grant revocation on existing sessions', async () => {
    const { app, db, fixtures, cookie } = get();
    await db.platformGrant.update({
      where: { userId: fixtures.userId },
      data: { isActive: false },
    });
    try {
      await request(app.getHttpServer())
        .get(root + '/overview')
        .set('Cookie', cookie)
        .expect(403);
    } finally {
      await db.platformGrant.update({
        where: { userId: fixtures.userId },
        data: { isActive: true, tokenVersion: { increment: 1 } },
      });
    }
  });
  it('rechecks an inactive platform user', async () => {
    const { app, db, fixtures, cookie } = get();
    await db.user.update({
      where: { id: fixtures.userId },
      data: { isActive: false },
    });
    try {
      await request(app.getHttpServer())
        .get(root + '/overview')
        .set('Cookie', cookie)
        .expect(403);
    } finally {
      await db.user.update({
        where: { id: fixtures.userId },
        data: { isActive: true, tokenVersion: { increment: 1 } },
      });
    }
  });
  it('honors global user-session revocation', async () => {
    const { app, db, fixtures, cookie } = get();
    await db.user.update({
      where: { id: fixtures.userId },
      data: { tokenVersion: { increment: 1 } },
    });
    await request(app.getHttpServer())
      .get(root + '/auth/me')
      .set('Cookie', cookie)
      .expect(401);
  });
  it('logs out platform sessions without logging out the staff audience', async () => {
    const { app, fixtures, cookie } = get();
    const auth = app.get(AuthService);
    const staff = await auth.login(platformLogin);
    const logout = await request(app.getHttpServer())
      .post(root + '/auth/logout')
      .set('Cookie', cookie)
      .expect(200);
    expect(logout.headers['set-cookie'][0]).toMatch(
      /^platform_token=; Path=\//,
    );
    await request(app.getHttpServer())
      .get(root + '/auth/me')
      .set('Cookie', cookie)
      .expect(401);
    const staffMe = await request(app.getHttpServer())
      .get('/api/v1/admin/auth/me')
      .set('Cookie', `admin_token=${staff.token}`)
      .expect(200);
    expect(staffMe.body.data.id).toBe(fixtures.userId);
  });
  it('clears an expired or missing platform cookie', async () => {
    const { app } = get();
    await request(app.getHttpServer())
      .post(root + '/auth/logout')
      .expect(200);
    await request(app.getHttpServer())
      .post(root + '/auth/logout')
      .set('Cookie', 'platform_token=expired')
      .expect(200);
  });
  it('blocks foreign browser origins for platform session mutations', async () => {
    const { app, cookie } = get();
    await request(app.getHttpServer())
      .post(root + '/auth/login')
      .set('Origin', 'https://evil.example')
      .send(platformLogin)
      .expect(403);
    await request(app.getHttpServer())
      .post(root + '/auth/logout')
      .set('Origin', 'https://evil.example')
      .set('Cookie', cookie)
      .expect(403);
    await request(app.getHttpServer())
      .get(root + '/auth/me')
      .set('Cookie', cookie)
      .expect(200);
    await request(app.getHttpServer())
      .post(root + '/auth/login')
      .set('Origin', env.CORS_ORIGINS[0]!)
      .send(platformLogin)
      .expect(200);
  });
  it('rate-limits platform sign-in attempts', async () => {
    const { app } = get();
    for (let i = 0; i < 5; i++)
      await request(app.getHttpServer())
        .post(root + '/auth/login')
        .send({ email: 'missing@platform-e2e.test', password: 'wrong' })
        .expect(401);
    await request(app.getHttpServer())
      .post(root + '/auth/login')
      .send({ email: 'missing@platform-e2e.test', password: 'wrong' })
      .expect(429);
  });
}
