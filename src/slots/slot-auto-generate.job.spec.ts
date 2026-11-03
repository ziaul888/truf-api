import type { SystemStateService } from '../settings/system-state.service.js';
import { SlotAutoGenerateJob } from './slot-auto-generate.job.js';
import type { SlotGeneratorService } from './slot-generator.service.js';

const KEY = 'weekend_fri_sat_cleanup';

function setup(stored: object | null = null) {
  const generator = {
    retireClosedDays: vi.fn(async () => ({ removed: 3, blocked: 1 })),
    fillWindow: vi.fn(async () => 0),
  };
  const state = { get: vi.fn(async () => stored), set: vi.fn(async () => undefined) };
  const job = new SlotAutoGenerateJob(generator as unknown as SlotGeneratorService, state as unknown as SystemStateService);
  return { generator, state, run: () => (job as unknown as { run(): Promise<void> }).run() };
}

describe('SlotAutoGenerateJob', () => {
  it('runs the closed-day cleanup before filling the window, and records it', async () => {
    const { generator, state, run } = setup();
    await run();
    expect(generator.retireClosedDays.mock.invocationCallOrder[0]!).toBeLessThan(generator.fillWindow.mock.invocationCallOrder[0]!);
    expect(state.set).toHaveBeenCalledWith(KEY, expect.objectContaining({ removed: 3, blocked: 1 }));
  });

  it('does not run the cleanup again once recorded', async () => {
    const { generator, state, run } = setup({ removed: 3, blocked: 1 });
    await run();
    expect(generator.retireClosedDays).not.toHaveBeenCalled();
    expect(state.set).not.toHaveBeenCalled();
    expect(generator.fillWindow).toHaveBeenCalled();
  });

  it('still fills the window when the cleanup fails, and retries on the next run', async () => {
    const { generator, state, run } = setup();
    generator.retireClosedDays.mockRejectedValueOnce(new Error('db down'));
    await run();
    expect(state.set).not.toHaveBeenCalled();
    expect(generator.fillWindow).toHaveBeenCalled();
    await run();
    expect(state.set).toHaveBeenCalledTimes(1);
  });
});
