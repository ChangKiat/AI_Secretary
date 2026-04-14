import { google } from 'googleapis';

const scopes = [
    'https://www.googleapis.com/auth/spreadsheets',
    'https://www.googleapis.com/auth/calendar'
];

let auth;

if (process.env.GOOGLE_CREDENTIALS_JSON) {
    console.log("☁️ Running on Cloud: Using injected Google Credentials");
    
    const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);
    
    auth = new google.auth.GoogleAuth({
        credentials, 
        scopes,
    });
} 
else {
    console.log("💻 Running Locally: Using google-credentials.json file");
    
    auth = new google.auth.GoogleAuth({
        keyFile: './google-credentials.json',
        scopes,
    });
}

export const googleAuth = auth;