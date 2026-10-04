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
    console.log('fixedSchedule self-check ok');
}
