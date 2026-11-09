import type { Prisma } from '../generated/prisma/client.js';
import { contactEmailOf, upsertCustomerByPhone } from './customer-upsert.js';

const contact = { name: 'Rakib', phone: '+8801711000000' };

function db(existing: object | null) {
  const customer = {
    findUnique: vi.fn(async () => existing),
    create: vi.fn(async () => ({ id: 'c-new' })),
    update: vi.fn(async () => ({})),
  };
  return { customer, client: { customer } as unknown as Prisma.TransactionClient };
}

describe('upsertCustomerByPhone', () => {
  it('creates a customer without an email', async () => {
    const { customer, client } = db(null);
    await expect(upsertCustomerByPhone(client, { ...contact, email: null }, true)).resolves.toBe('c-new');
    expect(customer.create).toHaveBeenCalledWith({ data: { ...contact, email: null } });
  });

  it('a blank email never clears the stored one on overwrite', async () => {
    const { customer, client } = db({ id: 'c-1', email: 'old@x.test', deletedAt: null });
    await upsertCustomerByPhone(client, { ...contact, email: null }, true);
    expect(customer.update).toHaveBeenCalledWith({ where: { id: 'c-1' }, data: { name: 'Rakib', deletedAt: null } });
  });

  it('a given email replaces the stored one on overwrite', async () => {
    const { customer, client } = db({ id: 'c-1', email: 'old@x.test', deletedAt: null });
    await upsertCustomerByPhone(client, { ...contact, email: 'new@x.test' }, true);
    expect(customer.update).toHaveBeenCalledWith({ where: { id: 'c-1' }, data: { name: 'Rakib', email: 'new@x.test', deletedAt: null } });
  });

  it('without overwrite only restores a deleted customer', async () => {
    const { customer, client } = db({ id: 'c-1', email: 'old@x.test', deletedAt: new Date() });
    await upsertCustomerByPhone(client, { ...contact, email: 'new@x.test' }, false);
    expect(customer.update).toHaveBeenCalledWith({ where: { id: 'c-1' }, data: { deletedAt: null } });
  });
});

describe('contactEmailOf', () => {
  it('uses the given email, else the stored one, else null', async () => {
    const stored = db({ email: 'stored@x.test' });
    await expect(contactEmailOf(stored.client, 'c-1', 'given@x.test')).resolves.toBe('given@x.test');
    expect(stored.customer.findUnique).not.toHaveBeenCalled();
    await expect(contactEmailOf(stored.client, 'c-1', null)).resolves.toBe('stored@x.test');
    await expect(contactEmailOf(db({ email: null }).client, 'c-1', undefined)).resolves.toBeNull();
  });
});
