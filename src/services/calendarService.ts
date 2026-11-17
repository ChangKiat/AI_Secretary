import { google } from 'googleapis';
import { googleAuth } from './googleClient';

const calendar = google.calendar({ version: 'v3', auth: googleAuth });
const TIMEZONE = 'Asia/Kuala_Lumpur';
const CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID || 'primary';

export type CalendarEventSummary = {
    id: string;
    title: string;
    start?: string | null;
    end?: string | null;
};

export type CreatedCalendarEvent = {
    start: string;
    /** Name of the calendar it landed on, when Google gives one. */
    calendarName?: string | null;
    /** On the service account's own calendar (GOOGLE_CALENDAR_ID missing), which the user can't see. */
    onBotPrivateCalendar: boolean;
};

export class CalendarCreateError extends Error {}

function parseEventTime(value: string, label: string): Date {
    const match = typeof value === 'string' &&
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:\d{2})?$/.exec(value);
    const time = match ? new Date(match[1] ? value : `${value}+08:00`) : new Date(NaN);
    if (!Number.isFinite(time.getTime())) {
        throw new CalendarCreateError(`I need a valid ${label} date and time for the event.`);
    }
    return time;
}

/** Says where the event really went, so a save the user can't see never reads as a success. */
export function formatCalendarEventReply(title: string, event: CreatedCalendarEvent): string {
    const when = new Date(event.start).toLocaleString('en-MY', {
        timeZone: TIMEZONE,
        weekday: 'short',
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
    });
    if (event.onBotPrivateCalendar) {
        return (
            `⚠️ Not on your calendar\n\n` +
            `"${title}" (${when}) was saved to the bot's private calendar, which you can't see.\n\n` +
            `To fix it, set GOOGLE_CALENDAR_ID to your calendar's ID where the bot runs, restart the bot, and send this event again.`
        );
    }
    const where = event.calendarName ? `your "${event.calendarName}" calendar` : 'your calendar';
    return `📅 Event Scheduled!\n\nAdded "${title}" to ${where}.\n\n🗓️ ${when}`;
}

function dayBounds(dateString: string): { timeMin: string; timeMax: string } {
    const startOfDay = new Date(dateString);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(dateString);
    endOfDay.setHours(23, 59, 59, 999);
    return { timeMin: startOfDay.toISOString(), timeMax: endOfDay.toISOString() };
}

function todayYmd(): string {
    return new Date().toLocaleDateString('en-CA', { timeZone: TIMEZONE });
}

export async function createCalendarEvent(
    title: string,
    startDateTime: string,
    endDateTime: string,
    description: string = ''
): Promise<CreatedCalendarEvent> {
    const start = parseEventTime(startDateTime, 'start');
    const end = endDateTime
        ? parseEventTime(endDateTime, 'end')
        : new Date(start.getTime() + 60 * 60 * 1000);
    if (end <= start) {
        throw new CalendarCreateError('The event end time must be after its start time.');
    }

    try {
        const event = {
            summary: title,
            description: description,
            start: {
                dateTime: start.toISOString(),
                timeZone: TIMEZONE,
            },
            end: {
                dateTime: end.toISOString(),
                timeZone: TIMEZONE,
            },
        };

        const response = await calendar.events.insert({
            calendarId: CALENDAR_ID,
            requestBody: event,
        });

        const organizer = response.data.organizer;
        return {
            start: response.data.start?.dateTime || start.toISOString(),
            calendarName: organizer?.displayName,
            onBotPrivateCalendar:
                organizer?.email?.endsWith('.gserviceaccount.com') ?? CALENDAR_ID === 'primary',
        };
    } catch (error) {
        const failure = error as {
            response?: { status?: number; data?: { error?: { message?: string; errors?: { reason?: string }[] } } };
            message?: string;
            code?: string;
        };
        const status = failure.response?.status;
        const details = failure.response?.data?.error;
        const reason = details?.errors?.[0]?.reason;
        console.error('Calendar event creation failed', {
            status, reason, message: details?.message || failure.message, code: failure.code,
        });
        if (reason === 'accessNotConfigured') {
            throw new CalendarCreateError('Enable the Google Calendar API in the bot’s Google Cloud project.');
        }
        if (status === 401 || failure.code === 'ENOENT') {
            throw new CalendarCreateError('Check the bot’s Google credentials on the deployed service.');
        }
        if (status === 404 || (status === 403 && (reason === 'forbidden' || reason === 'requiredAccessLevel'))) {
            throw new CalendarCreateError(
                'Check GOOGLE_CALENDAR_ID on the deployed bot and give its Google service account permission to make changes to that calendar.'
            );
        }
        if (status === 400) {
            throw new CalendarCreateError('Google Calendar rejected the event details. Check the start and end times and try again.');
        }
        throw new CalendarCreateError('I couldn’t confirm the event was created. Check your calendar before trying again.');
    }
}

export async function getSchedule(dateString: string) {
    try {
        const { timeMin, timeMax } = dayBounds(dateString);
        const response = await calendar.events.list({
            calendarId: CALENDAR_ID,
            timeMin,
            timeMax,
            singleEvents: true,
            orderBy: 'startTime',
        });

        const events = response.data.items || [];

        if (events.length === 0) {
            return 'No events scheduled for this day.';
        }

        return events.map(
            (e): CalendarEventSummary => ({
                id: e.id!,
                title: e.summary || '(no title)',
                start: e.start?.dateTime || e.start?.date,
                end: e.end?.dateTime || e.end?.date,
            })
        );
    } catch (error: any) {
        console.error('Error reading calendar:', error.response?.data || error.message);
        throw new Error('Failed to fetch schedule.');
    }
}

export async function findCalendarEvents(opts: {
    title: string;
    date?: string;
}): Promise<CalendarEventSummary[]> {
    const date = opts.date || todayYmd();
    const schedule = await getSchedule(date);
    if (typeof schedule === 'string') return [];

    const needle = opts.title.trim().toLowerCase();
    return schedule.filter((e) => e.title.toLowerCase().includes(needle));
}

export async function rescheduleCalendarEvent(
    eventId: string,
    startDateTime: string,
    endDateTime?: string,
    newTitle?: string
) {
    try {
        const existing = await calendar.events.get({
            calendarId: CALENDAR_ID,
            eventId,
        });

        let end = endDateTime;
        if (!end) {
            const oldStart = existing.data.start?.dateTime;
            const oldEnd = existing.data.end?.dateTime;
            if (oldStart && oldEnd) {
                const durationMs = new Date(oldEnd).getTime() - new Date(oldStart).getTime();
                end = new Date(new Date(startDateTime).getTime() + durationMs).toISOString();
            } else {
                end = new Date(new Date(startDateTime).getTime() + 60 * 60 * 1000).toISOString();
            }
        }

        const response = await calendar.events.patch({
            calendarId: CALENDAR_ID,
            eventId,
            requestBody: {
                ...(newTitle ? { summary: newTitle } : {}),
                start: { dateTime: startDateTime, timeZone: TIMEZONE },
                end: { dateTime: end, timeZone: TIMEZONE },
            },
        });

        return {
            id: response.data.id!,
            title: response.data.summary || '(no title)',
            start: response.data.start?.dateTime || response.data.start?.date,
            end: response.data.end?.dateTime || response.data.end?.date,
        } satisfies CalendarEventSummary;
    } catch (error: any) {
        console.error('--- RAW CALENDAR RESCHEDULE ERROR ---');
        console.dir(error.response?.data || error, { depth: null });
        throw new Error('Failed to reschedule the calendar event.');
    }
}

export async function cancelCalendarEvent(eventId: string) {
    try {
        await calendar.events.delete({
            calendarId: CALENDAR_ID,
            eventId,
        });
    } catch (error: any) {
        console.error('--- RAW CALENDAR CANCEL ERROR ---');
        console.dir(error.response?.data || error, { depth: null });
        throw new Error('Failed to cancel the calendar event.');
    }
}
