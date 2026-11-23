import { afterEach, expect, it, vi } from 'vitest';
import { env } from '../config/env.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { SettingsStore } from '../settings/settings-store.service.js';
import { EmailService } from './email.service.js';

const previousKey = env.RESEND_API_KEY;
afterEach(() => {
  env.RESEND_API_KEY = previousKey;
  vi.unstubAllGlobals();
});

it('sends and logs a plain-text email through Resend', async () => {
  env.RESEND_API_KEY = 're_test_key';
  const send = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
  vi.stubGlobal('fetch', send);
  const create = vi.fn().mockResolvedValue({});
  const mail = new EmailService(
    { emailLog: { create } } as unknown as PrismaService,
    { get: async () => ({ name: 'TurfOrg' }) } as unknown as SettingsStore,
  );
  expect(
    await mail.deliver({
      to: 'owner@example.test',
      subject: 'Test email',
      text: 'TurfOrg test',
      kind: 'test',
    }),
  ).toEqual({ ok: true });
  expect(send).toHaveBeenCalledOnce();
  expect(send.mock.calls[0][0]).toBe('https://api.resend.com/emails');
  expect(JSON.parse(send.mock.calls[0][1].body)).toMatchObject({
    to: ['owner@example.test'],
    subject: 'Test email',
    text: 'TurfOrg test',
  });
  expect(create).toHaveBeenCalledWith({
    data: expect.objectContaining({ ok: true, kind: 'test' }),
  });
});

it('records Resend rejection as a failed delivery', async () => {
  env.RESEND_API_KEY = 're_test_key';
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(new Response(null, { status: 403 })),
  );
  const create = vi.fn().mockResolvedValue({});
  const mail = new EmailService(
    { emailLog: { create } } as unknown as PrismaService,
    { get: async () => ({ name: 'TurfOrg' }) } as unknown as SettingsStore,
  );
  expect(
    await mail.send({
      to: 'owner@example.test',
      subject: 'Test',
      text: 'Test',
      kind: 'test',
    }),
  ).toBe(false);
  expect(create).toHaveBeenCalledWith({
    data: expect.objectContaining({
      ok: false,
      error: 'Resend rejected the email (HTTP 403)',
    }),
  });
});
