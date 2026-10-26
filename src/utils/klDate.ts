/** YYYY-MM-DD in Malaysia time, `offsetDays` from today. */
export function klIsoDate(offsetDays = 0): string {
    return new Date(Date.now() + offsetDays * 86_400_000).toLocaleDateString('en-CA', {
        timeZone: 'Asia/Kuala_Lumpur',
    });
}
