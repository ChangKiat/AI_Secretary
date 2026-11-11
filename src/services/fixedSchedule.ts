/**
 * Shared due-date rules for fixed expenses / contributions.
 * Months are 1-based (1 = January). Keep this file free of DB/service imports
 * (no expenseService / fixedContributionService) to avoid circular imports.
 */

/** Number of days in the given month (month is 1-based). */
export function lastDayOfMonth(year: number, month: number): number {
    return new Date(year, month, 0).getDate();
}

/** YYYY-MM-DD due date in the given month, clamping day 29-31 to the month's last day. */
export function dueDateInMonth(dayOfMonth: number, year: number, month: number): string {
    const day = Math.min(dayOfMonth, lastDayOfMonth(year, month));
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** True when `currentMonth` falls on the schedule that starts at `startMonth` and repeats every `frequencyMonths` (0/empty = monthly). */
export function isFrequencyDue(startMonth: number, frequencyMonths: number, currentMonth: number): boolean {
    const monthDiff = currentMonth - startMonth;
    const freq = frequencyMonths || 1;
    return ((monthDiff % freq) + freq) % freq === 0;
}

/** Whole days from `from` to `to` (both YYYY-MM-DD); negative when `to` is the earlier date. */
export function daysBetween(from: string, to: string): number {
    const utc = (iso: string) => {
        const [y, m, d] = iso.split('-').map(Number);
        return Date.UTC(y, m - 1, d);
    };
    return Math.round((utc(to) - utc(from)) / 86_400_000);
}

/** `date` (YYYY-MM-DD) moved by `days`. */
export function addDays(date: string, days: number): string {
    const [y, m, d] = date.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/**
 * For a bill that repeats every `intervalDays` days (e.g. a 30-day pass) instead of on a day of
 * the month: due on `startDate` and every `intervalDays` days after it, never before it.
 */
export function isIntervalDue(startDate: string, intervalDays: number, date: string): boolean {
    if (!Number.isInteger(intervalDays) || intervalDays < 1) return false;
    const diff = daysBetween(startDate, date);
    return diff >= 0 && diff % intervalDays === 0;
}

/** The first due date of an every-N-days bill on or after `from`. */
export function nextIntervalDueDate(startDate: string, intervalDays: number, from: string): string {
    const behind = daysBetween(startDate, from);
    if (behind <= 0 || !Number.isInteger(intervalDays) || intervalDays < 1) return startDate;
    return addDays(startDate, Math.ceil(behind / intervalDays) * intervalDays);
}

// ponytail self-check: pure date math, no DB
if (require.main === module) {
    const eq = (actual: unknown, expected: unknown, label: string) => {
        if (actual !== expected) throw new Error(`${label}: expected ${expected}, got ${actual}`);
    };
    eq(lastDayOfMonth(2026, 2), 28, 'lastDayOfMonth Feb 2026');
    eq(lastDayOfMonth(2028, 2), 29, 'lastDayOfMonth Feb 2028');
    eq(lastDayOfMonth(2026, 12), 31, 'lastDayOfMonth Dec');
    eq(dueDateInMonth(31, 2026, 2), '2026-02-28', 'dueDateInMonth clamps 31 in Feb');
    eq(dueDateInMonth(30, 2026, 4), '2026-04-30', 'dueDateInMonth 30 in Apr');
    eq(dueDateInMonth(31, 2026, 4), '2026-04-30', 'dueDateInMonth clamps 31 in Apr');
    eq(dueDateInMonth(5, 2026, 1), '2026-01-05', 'dueDateInMonth pads');
    eq(isFrequencyDue(1, 1, 7), true, 'monthly always due');
    eq(isFrequencyDue(1, 0, 7), true, 'frequency 0 treated as monthly');
    eq(isFrequencyDue(1, 3, 4), true, 'quarterly from Jan due in Apr');
    eq(isFrequencyDue(1, 3, 5), false, 'quarterly from Jan not due in May');
    eq(isFrequencyDue(11, 3, 2), true, 'quarterly from Nov due in Feb (before start month)');
    eq(isFrequencyDue(6, 12, 6), true, 'yearly due in start month');
    eq(isFrequencyDue(6, 12, 7), false, 'yearly not due other months');
    eq(daysBetween('2026-11-11', '2026-12-11'), 30, 'daysBetween across a month end');
    eq(daysBetween('2026-12-20', '2027-01-19'), 30, 'daysBetween across a year end');
    eq(daysBetween('2026-11-11', '2026-11-10'), -1, 'daysBetween backwards');
    eq(addDays('2026-11-11', 30), '2026-12-11', 'addDays 30');
    eq(addDays('2028-02-28', 2), '2028-03-01', 'addDays over a leap day');
    eq(isIntervalDue('2026-11-11', 30, '2026-11-11'), true, 'interval due on its start date');
    eq(isIntervalDue('2026-11-11', 30, '2026-12-11'), true, 'interval due 30 days later');
    eq(isIntervalDue('2026-11-11', 30, '2027-01-10'), true, 'interval due 60 days later');
    eq(isIntervalDue('2026-11-11', 30, '2026-12-10'), false, 'interval not due a day early');
    eq(isIntervalDue('2026-11-11', 30, '2026-10-12'), false, 'interval not due before its start date');
    eq(isIntervalDue('2026-11-11', 0, '2026-11-11'), false, 'interval 0 is never due');
    eq(nextIntervalDueDate('2026-11-11', 30, '2026-11-01'), '2026-11-11', 'next due before the start date');
    eq(nextIntervalDueDate('2026-11-11', 30, '2026-11-12'), '2026-12-11', 'next due after the start date');
    eq(nextIntervalDueDate('2026-11-11', 30, '2026-12-11'), '2026-12-11', 'next due on a due date');
    console.log('fixedSchedule self-check ok');
}
