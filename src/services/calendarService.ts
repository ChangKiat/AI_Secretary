import { google } from 'googleapis';
import { googleAuth } from './googleClient';

const calendar = google.calendar({ version: 'v3', auth: googleAuth });
const TIMEZONE = 'Asia/Kuala_Lumpur';

export type CalendarEventSummary = {
    id: string;
    title: string;
    start?: string | null;
    end?: string | null;
};

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
) {
    try {
        if (!startDateTime || startDateTime === '') {
            throw new Error('Start date is missing. I need a specific date and time.');
        }

        const event = {
            summary: title,
            description: description,
            start: {
                dateTime: startDateTime,
                timeZone: TIMEZONE,
            },
            end: {
                dateTime:
                    endDateTime ||
                    new Date(new Date(startDateTime).getTime() + 60 * 60 * 1000).toISOString(),
                timeZone: TIMEZONE,
            },
        };

        const response = await calendar.events.insert({
            calendarId: 'primary',
            requestBody: event,
        });

        return response.data.htmlLink;
    } catch (error: any) {
        console.error('--- RAW CALENDAR ERROR ---');
        console.dir(error.response?.data || error, { depth: null });
        throw new Error('Failed to create the calendar event.');
    }
}

export async function grantCalendarAccess() {
    try {
        console.log("Attempting to make you the owner of the bot's calendar...");
        await calendar.acl.insert({
            calendarId: 'primary',
            requestBody: {
                role: 'owner',
                scope: {
                    type: 'user',
                    value: 'changkiat1995@gmail.com',
                },
            },
        });
        console.log('🎉 SUCCESS: You are now the Co-Owner of the bot\'s calendar!');
    } catch (error: any) {
        console.error('Failed to share calendar:', error.response?.data || error.message);
    }
}

export async function getSchedule(dateString: string) {
    try {
        const { timeMin, timeMax } = dayBounds(dateString);
        const response = await calendar.events.list({
            calendarId: 'primary',
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
            calendarId: 'primary',
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
            calendarId: 'primary',
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
            calendarId: 'primary',
            eventId,
        });
    } catch (error: any) {
        console.error('--- RAW CALENDAR CANCEL ERROR ---');
        console.dir(error.response?.data || error, { depth: null });
        throw new Error('Failed to cancel the calendar event.');
    }
}
