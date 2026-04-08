import { google } from 'googleapis';

export const googleAuth = new google.auth.GoogleAuth({
    keyFile: './google-credentials.json', 
    scopes: [
        'https://www.googleapis.com/auth/spreadsheets',
        'https://www.googleapis.com/auth/calendar'
    ],
});