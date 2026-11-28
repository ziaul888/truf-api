import { afterEach, expect, it, vi } from 'vitest';
import { env } from '../config/env.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { SettingsStore } from '../settings/settings-store.service.js';
import { EmailService } from './email.service.js';

const previousResendKey = env.RESEND_API_KEY;
const previousSendGridKey = env.SENDGRID_API_KEY;
afterEach(() => {
  env.RESEND_API_KEY = previousResendKey;
  env.SENDGRID_API_KEY = previousSendGridKey;
  vi.unstubAllGlobals();
});

it('prefers Resend and logs its accepted message when both providers have keys', async () => {
  env.RESEND_API_KEY = 're_test_key';
  env.SENDGRID_API_KEY = 'SG.test-key';
  const send = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
  vi.stubGlobal('fetch', send);
  const create = vi.fn().mockResolvedValue({});
  const mail = new EmailService(
    { emailLog: { create } } as unknown as PrismaService,
    { get: async () => ({ name: 'TurfOrg' }) } as unknown as SettingsStore,
  );
  expect(mail.provider).toBe('resend');
  expect(mail.configured).toBe(true);
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

it('reports SendGrid when only SendGrid has a key and null without keys', () => {
  env.RESEND_API_KEY = undefined;
  env.SENDGRID_API_KEY = 'SG.test-key';
  const mail = new EmailService({} as PrismaService, {} as SettingsStore);
  expect(mail.provider).toBe('sendgrid');
  expect(mail.configured).toBe(true);

  env.SENDGRID_API_KEY = undefined;
  expect(mail.provider).toBeNull();
  expect(mail.configured).toBe(false);
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
