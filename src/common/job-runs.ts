/** Background jobs whose last run the System page shows. */
export type JobName = 'slotGeneration' | 'holdExpiry' | 'completion' | 'dueReminders' | 'dueDigest';

export interface JobRun {
  lastRunAt: Date;
  ok: boolean;
  /** Message only, never a stack. */
  error?: string;
}

// In-process: a restart clears it, and the System page shows when the server started.
const runs = new Map<JobName, JobRun>();

/** Runs a job and remembers when it ran and whether it threw (it still throws). */
export async function trackJob<T>(name: JobName, job: () => Promise<T>): Promise<T> {
  try {
    const result = await job();
    runs.set(name, { lastRunAt: new Date(), ok: true });
    return result;
  } catch (err) {
    runs.set(name, { lastRunAt: new Date(), ok: false, error: err instanceof Error ? err.message : String(err) });
    throw err;
  }
}

export const lastJobRun = (name: JobName): JobRun | null => runs.get(name) ?? null;
