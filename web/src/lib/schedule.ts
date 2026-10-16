// When the scheduled scan runs, read from the cron text the service reports. Two shapes are used: "0 2 * * *" (daily at an hour, UTC)
// and "0 */3 * * *" (every few hours). Anything else is read as the daily 02:00 default.
export interface Schedule { label: string; periodMs: number; next(now: Date): Date }

const DAY = 86_400_000;

export function parseSchedule(cron: string | undefined | null): Schedule {
  const parts = (cron ?? '').trim().split(/\s+/);
  const every = parts.length === 5 && parts[0] === '0' && /^\*\/(\d{1,2})$/.test(parts[1]) && parts.slice(2).every((p) => p === '*') ? Number(parts[1].slice(2)) : 0;
  if (every >= 1 && every <= 12) {
    return {
      label: `every ${every} h`,
      periodMs: every * 3_600_000,
      next: (now) => {
        const d = new Date(now.getTime());
        d.setUTCMinutes(0, 0, 0);
        do d.setUTCHours(d.getUTCHours() + 1, 0, 0, 0); while (d.getUTCHours() % every !== 0 || d.getTime() <= now.getTime());
        return d;
      },
    };
  }
  const hour = parts.length === 5 && parts[0] === '0' && /^\d{1,2}$/.test(parts[1]) && parts.slice(2).every((p) => p === '*') && Number(parts[1]) < 24 ? Number(parts[1]) : 2;
  return {
    label: `daily ${String(hour).padStart(2, '0')}:00 UTC`,
    periodMs: DAY,
    next: (now) => {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour, 0, 0));
      if (d.getTime() <= now.getTime()) d.setUTCDate(d.getUTCDate() + 1);
      return d;
    },
  };
}
