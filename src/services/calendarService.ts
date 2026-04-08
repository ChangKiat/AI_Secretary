import { google } from 'googleapis';
import { googleAuth } from './googleClient'; 

const calendar = google.calendar({ version: 'v3', auth: googleAuth });
export async function createCalendarEvent(title: string, startDateTime: string, endDateTime: string, description: string = "") {
    try {
        if (!startDateTime || startDateTime === "") {
            throw new Error("Start date is missing. I need a specific date and time.");
        }

        const event = {
            summary: title,
            description: description,
            start: {
                dateTime: startDateTime, 
                timeZone: 'Asia/Kuala_Lumpur',
            },
            end: {
                dateTime: endDateTime || new Date(new Date(startDateTime).getTime() + 60 * 60 * 1000).toISOString(),
                timeZone: 'Asia/Kuala_Lumpur',
            }
        };

        const response = await calendar.events.insert({
            calendarId: 'primary', 
            requestBody: event,
        });

        return response.data.htmlLink;
    } catch (error: any) {
        console.error('--- RAW CALENDAR ERROR ---');
        console.dir(error.response?.data || error, { depth: null });
        throw new Error("Failed to create the calendar event.");
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
                    value: 'changkiat1995@gmail.com'
                }
            }
        });
        console.log("🎉 SUCCESS: You are now the Co-Owner of the bot's calendar!");
    } catch (error: any) {
        console.error("Failed to share calendar:", error.response?.data || error.message);
    }
}

export async function getSchedule(dateString: string) {
    try {
        const startOfDay = new Date(dateString);
        startOfDay.setHours(0, 0, 0, 0);
        
        const endOfDay = new Date(dateString);
        endOfDay.setHours(23, 59, 59, 999);

        const response = await calendar.events.list({
            calendarId: 'primary', 
            timeMin: startOfDay.toISOString(),
            timeMax: endOfDay.toISOString(),
            singleEvents: true,
            orderBy: 'startTime',
        });

        const events = response.data.items || [];
        
        if (events.length === 0) {
            return "No events scheduled for this day.";
        }

        return events.map(e => ({
            title: e.summary,
            start: e.start?.dateTime || e.start?.date,
            end: e.end?.dateTime || e.end?.date
        }));
        
    } catch (error: any) {
        console.error('Error reading calendar:', error.response?.data || error.message);
        throw new Error("Failed to fetch schedule.");
    }
}