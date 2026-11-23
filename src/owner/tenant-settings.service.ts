import { Injectable } from '@nestjs/common';
import {
  DEFAULT_NOTIFICATIONS,
  SETTINGS_SECTIONS,
  type ResetSettingsInput,
  type UpdateNotificationsInput,
} from '../settings/notifications.schemas.js';
import type { NotificationsDto } from '../settings/notification-settings.service.js';
import type { PaymentsStatus } from '../settings/system-status.service.js';
import {
  WebsiteStoredSchema,
  type UpdateWebsiteInput,
} from '../settings/website.schemas.js';
import { DEFAULT_WEBSITE } from '../settings/website-defaults.js';
import { portalWalletNumber } from '../bookings/portal-methods.js';
import type { UpdateSlotSettingsInput } from '../slots/slots.schemas.js';
import type { TenantOperator } from './owner-session.js';
import { requireVenue } from './owner-venue.js';
import {
  TENANT_SLOT_DEFAULTS,
  TenantSettingsStore,
  type TurfSettings,
} from './tenant-settings.store.js';
import { AppError } from '../common/app-error.js';
import type { Appearance } from '../settings/appearance.schemas.js';

@Injectable()
export class TenantSettingsService {
  constructor(private readonly store: TenantSettingsStore) {}

  async reset(
    operator: TenantOperator,
    { sections = [...SETTINGS_SECTIONS] }: ResetSettingsInput,
  ) {
    await this.store.write(operator.session, (current) => {
      const next: Partial<TurfSettings> = {};
      if (sections.includes('website')) next.website = DEFAULT_WEBSITE;
      if (sections.includes('slots')) next.slots = TENANT_SLOT_DEFAULTS;
      if (sections.includes('notifications')) {
        next.notifications = DEFAULT_NOTIFICATIONS;
        next.slots = {
          ...(next.slots ?? current.slots),
          notifyCustomerOnBlock: TENANT_SLOT_DEFAULTS.notifyCustomerOnBlock,
          notifyAdminOnBooking: TENANT_SLOT_DEFAULTS.notifyAdminOnBooking,
        };
      }
      return next;
    });
    return { sections };
  }

  async slots(operator: TenantOperator, input?: UpdateSlotSettingsInput) {
    const saved = input
      ? await this.store.write(operator.session, (current) => ({
          slots: { ...current.slots, ...input },
        }))
      : await this.store.read(operator);
    return { ...saved.slots, ...saved.meta('slots') };
  }

  async appearance(operator: TenantOperator, input?: Appearance) {
    if (!input) return (await this.store.read(operator)).appearance;
    if (operator.user.role !== 'owner') {
      throw new AppError(
        'Only the turf owner can change dashboard appearance',
        403,
        'FORBIDDEN',
      );
    }
    return (
      await this.store.write(operator.session, () => ({ appearance: input }))
    ).appearance;
  }

  async payments(operator: TenantOperator): Promise<PaymentsStatus> {
    const { slots } = await this.store.read(operator);
    return {
      stripe: {
        configured: false,
        mode: null,
        currency: operator.user.tenant.currency,
        webhook: { configured: false, lastEventAt: null, lastEventOk: null },
      },
      methods: {
        card: false,
        cash: true,
        bankTransfer: true,
        bkash: Boolean(portalWalletNumber(slots, 'bkash')),
        nagad: Boolean(portalWalletNumber(slots, 'nagad')),
      },
      portalCashEnabled: slots.portalCashEnabled,
    };
  }

  async website(operator: TenantOperator, input?: UpdateWebsiteInput) {
    const saved = input
      ? await this.store.write(operator.session, ({ website }) => {
          const next = WebsiteStoredSchema.parse({
            hero: input.hero ?? website.hero,
            sections: { ...website.sections, ...input.sections },
            social: input.social ?? website.social,
          });
          if (
            [next.hero.imageUrl, next.sections.visitUs.imageUrl].some(
              (url) => !url.startsWith('https://'),
            )
          ) {
            throw new AppError(
              'Use a full https:// image link',
              400,
              'INVALID_IMAGE_URL',
            );
          }
          return { website: next };
        })
      : await this.store.read(operator);
    return { ...saved.website, ...saved.meta('website') };
  }

  async portal(operator: TenantOperator, published?: boolean) {
    const saved = published === undefined
      ? await this.store.read(operator)
      : await this.store.write(operator.session, () => {
          if (published) requireVenue(operator);
          return { portalPublished: published };
        });
    return { published: saved.portalPublished, slug: operator.user.tenant.slug };
  }

  async notifications(
    operator: TenantOperator,
    input?: UpdateNotificationsInput,
  ) {
    const saved = input
      ? await this.store.write(operator.session, (current) =>
          applyNotificationSettings(current, input),
        )
      : await this.store.read(operator);
    return notificationDto(operator, saved);
  }
}

function applyNotificationSettings(
  { slots, notifications }: TurfSettings,
  input: UpdateNotificationsInput,
) {
  const { email, customer, staff } = input;
  return {
    notifications: {
      fromName:
        email?.fromName === undefined ? notifications.fromName : email.fromName,
      replyTo:
        email?.replyTo === undefined ? notifications.replyTo : email.replyTo,
      refundIssued: customer?.refundIssued ?? notifications.refundIssued,
      staffRecipients: staff?.recipients ?? notifications.staffRecipients,
      customerCancelled:
        staff?.customerCancelled ?? notifications.customerCancelled,
      dueDigest: staff?.dueDigest ?? notifications.dueDigest,
    },
    ...(customer?.slotBlocked !== undefined || staff?.newBooking !== undefined
      ? {
          slots: {
            ...slots,
            notifyCustomerOnBlock:
              customer?.slotBlocked ?? slots.notifyCustomerOnBlock,
            notifyAdminOnBooking:
              staff?.newBooking ?? slots.notifyAdminOnBooking,
          },
        }
      : {}),
  };
}

function notificationDto(
  operator: TenantOperator,
  saved: Awaited<ReturnType<TenantSettingsStore['read']>>,
): Omit<NotificationsDto, 'updatedAt'> & { updatedAt: string | null } {
  const { notifications: prefs, slots, venue } = saved;
  return {
    email: {
      configured: false,
      fromEmail: '',
      fromName: prefs.fromName,
      replyTo: prefs.replyTo,
      effectiveFromName:
        prefs.fromName ?? venue?.name ?? operator.user.tenant.name,
      effectiveReplyTo:
        prefs.replyTo ?? venue?.supportEmail ?? venue?.email ?? '',
    },
    customer: {
      bookingConfirmed: true,
      bookingCancelled: true,
      refundIssued: prefs.refundIssued,
      slotBlocked: slots.notifyCustomerOnBlock,
    },
    staff: {
      recipients: prefs.staffRecipients,
      newBooking: slots.notifyAdminOnBooking,
      customerCancelled: prefs.customerCancelled,
      dueDigest: prefs.dueDigest,
    },
    ...saved.meta('notifications'),
  };
}
