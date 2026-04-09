# 🤖 AI Secretary Telegram Bot

A highly proactive, AI-powered personal assistant built with Node.js and TypeScript. This bot uses the Google Gemini API to understand natural language and autonomously execute function calls to manage Google Calendar events and track financial expenses in Google Sheets.

## ✨ Features
- **Conversational UI:** Interact naturally via Telegram.
- **Autonomous Scheduling:** Extracts dates/times from chat and creates Google Calendar events.
- **Financial Tracking:** Logs expenses and recurring bills to Google Sheets.
- **Agentic Routing:** Uses Gemini Function Calling to intelligently route commands to the correct API.

## 📋 Prerequisites
Before you begin, ensure you have the following installed and set up:
- [Node.js](https://nodejs.org/) (v18 or higher)
- A Telegram Bot Token (from [@BotFather](https://t.me/botfather))
- A Google Gemini API Key
- A Google Cloud Service Account with access to Google Calendar and Google Sheets APIs.

## 🚀 Local Installation

1. **Clone the repository:**
   ```bash
   git clone <your-repository-url>
   cd AI_Secretary
   ```
2. **Install dependencies:**

  ```bash
  npm install
  ```
## ⚙️ Configuration

1. **Environment Variables:**
Create a .env file in the root directory and add your API keys:

  ```Code snippet
  TELEGRAM_BOT_TOKEN=your_telegram_token_here
  GEMINI_API_KEY=your_gemini_api_key_here
  SPREADSHEET_ID=your_google_sheet_id_here
  ```

2. **Google Credentials:**
Place your Google Service Account JSON key file in the root directory and rename it exactly to:
```google-credentials.json```
(Note: This file is securely ignored by Git).

## 💻 Running the Bot Locally
For Local Development:
To run the bot directly using TypeScript with hot-reloading:

  ```Bash
  npx tsx src/index.ts
  ```

## ☁️ Cloud Deployment (Free Hosting)
To host this bot online 24/7 for free, we recommend using Koyeb or Render.

**Step 1: Prepare ```package.json```**

Ensure your ```package.json``` has the correct build and start scripts required by cloud servers:

  ```
  JSON
  "scripts": {
    "build": "tsc",
    "start": "node dist/index.js"
  }
```
**Step 2: Push to GitHub**

Commit your code and push it to a private or public GitHub repository. (Ensure your ```.gitignore``` is working so you don't upload your credentials!)

**Step 3: Deploy to Cloud**

1. Log into Koyeb or Render and create a new Web Service.
2. Connect your GitHub account and select this repository.
3. Set the Build Command to ```npm install && npm run build.```
4. Set the Start Command to ```npm start.```
5. **Crucial:** In the hosting dashboard's Environment Variables section, manually add your ```TELEGRAM_BOT_TOKEN```,``` GEMINI_API_KEY```, and ```SPREADSHEET_ID```.
6. For your ```google-credentials.json```, you will need to stringify the JSON and save it as an Environment Variable (e.g., ```GOOGLE_CREDENTIALS_JSON```), then update ```googleClient.ts``` to parse it from the environment.

## 📂 Project Architecture
This project follows a strict separation of concerns for clean scaling:
- /src/services - Google API wrappers (calendarService.ts, sheetsService.ts).
- /src/tools - The Action registry orchestrating AI and Services (toolHandler.ts).
- /src/config - System prompts and configuration.
