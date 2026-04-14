import 'dotenv/config';
import { google } from 'googleapis';
import { googleAuth } from './googleClient';

const sheets = google.sheets({ version: 'v4', auth: googleAuth });
const SPREADSHEET_ID = process.env.SPREADSHEET_ID!;

export async function appendExpenseToSheet(date: string,amount: number, currency: string, category: string, description: string) {
    try {
        await sheets.spreadsheets.values.append({
            spreadsheetId: SPREADSHEET_ID,
            range: 'Expenses!A:E', 
            valueInputOption: 'USER_ENTERED',
            requestBody: {
                values: [
[date, amount, currency || 'MYR', category || 'General', description]        
        ],
            },
        });
        return true;
    } catch (error) {
        console.error('Google Sheets API Error:', error);
        throw new Error('Failed to append data to the spreadsheet.');
    }
}

function parseSheetDate(dateString: string): Date {
    try {
        const datePart = dateString.split(',')[0].trim();
        const [day, month, year] = datePart.split('/');
        return new Date(Number(year), Number(month) - 1, Number(day));
    } catch (e) {
        return new Date(0); 
    }
}

export async function getSpendingSummary(
    category?: string, 
    description?: string, 
    startDate?: string, 
    endDate?: string
) {
    try {
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: 'Expenses!A:E',
        });

        const rows = response.data.values;
        if (!rows || rows.length === 0) return { total: 0, breakdown: {} };

        const dataRows = rows.slice(1);

        let totalSpent = 0;
        const breakdown: Record<string, number> = {};

        dataRows.forEach(row => {
            const rowDateString = row[0]; 
            const rowAmount = parseFloat(row[1]) || 0;
            const rowCategory = row[3] ? row[3].toLowerCase() : 'uncategorized';
            const rowDescription = row[4]?.toLowerCase();

            let match = true;

            if (category && rowCategory !== category.toLowerCase()) match = false;
            if (description && !rowDescription?.includes(description.toLowerCase())) match = false;

            if ((startDate || endDate) && rowDateString) {
                const rowDate = parseSheetDate(rowDateString);
                if (startDate && rowDate < new Date(startDate)) match = false;
                if (endDate && rowDate > new Date(endDate)) match = false;
            }

            if (match) {
                totalSpent += rowAmount;
                breakdown[rowCategory] = (breakdown[rowCategory] || 0) + rowAmount;
            }
        });

        return { total: totalSpent, breakdown: breakdown };
    } catch (error) {
        console.error('Error reading from Sheets:', error);
        throw new Error('Failed to read the spreadsheet.');
    }
}

export async function addFixedExpenseToSheet(
    dayOfMonth: number, 
    amount: number, 
    currency: string, 
    category: string, 
    description: string,
    frequency: number,     
    startMonth: number 
) {
    try {
        await sheets.spreadsheets.values.append({
            spreadsheetId: SPREADSHEET_ID,
            range: 'FixedExpenses!A:G',
            valueInputOption: 'USER_ENTERED',
            requestBody: {
                values: [
                    [dayOfMonth, amount, currency, category, description, frequency, startMonth]
                ],
            },
        });
        return true;
    } catch (error) {
        console.error('Error adding fixed expense:', error);
        throw new Error('Failed to add recurring expense rule.');
    }
}

export async function getFixedExpensesForToday(): Promise<any[]> {
    try {
        const today = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kuala_Lumpur' }));
        const todayDay = today.getDate();
        const currentMonth = today.getMonth() + 1;

        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: 'FixedExpenses!A:G',
        });

        const rows = response.data.values;
        if (!rows || rows.length === 0) return [];

        const dataRows = rows.slice(1); 
        
        const todaysExpenses = dataRows.filter(row => {
            const rowDay = parseInt(row[0]);
            const frequency = parseInt(row[5]) || 1; 
            const startMonth = parseInt(row[6]) || currentMonth;

            if (rowDay !== todayDay) return false;

            const monthDiff = currentMonth - startMonth;
            const isDueThisMonth = ((monthDiff % frequency) + frequency) % frequency === 0;

            return isDueThisMonth;
        });
        
        return todaysExpenses.map(row => ({
            amount: parseFloat(row[1]),
            currency: row[2],
            category: row[3],
            description: row[4]
        }));
    } catch (error) {
        console.error('Error fetching today’s fixed expenses:', error);
        return [];
    }
}

export async function updateFixedExpensePrice(searchDescription: string, newAmount: number): Promise<boolean | string> {
    try {
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: 'FixedExpenses!A:G',
        });

        const rows = response.data.values;
        if (!rows || rows.length <= 1) return false; 

        let targetRowIndex = -1;
        
        for (let i = 1; i < rows.length; i++) {
            const rowDescription = rows[i][4]?.toLowerCase() || "";
            
            if (rowDescription.includes(searchDescription.toLowerCase())) {
                targetRowIndex = i + 1; 
                break;
            }
        }

        if (targetRowIndex === -1) return "not_found";

        await sheets.spreadsheets.values.update({
            spreadsheetId: SPREADSHEET_ID,
            range: `FixedExpenses!B${targetRowIndex}`, 
            valueInputOption: 'USER_ENTERED',
            requestBody: {
                values: [[newAmount]],
            },
        });

        return true;
    } catch (error) {
        console.error('Error updating fixed expense:', error);
        throw new Error('Failed to update the recurring expense.');
    }
}

export async function getAllFixedExpenses() {
    try {
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: 'FixedExpenses!A:G',
        });

        const rows = response.data.values;
        if (!rows || rows.length <= 1) return [];

        const dataRows = rows.slice(1);
        
        return dataRows
            .filter(row => row.length > 0 && row[0]) 
            .map(row => ({
                day: parseInt(row[0]),
                amount: parseFloat(row[1]),
                currency: row[2] || 'MYR',
                description: row[4] || 'Unnamed',
                frequency: parseInt(row[5]) || 1
            }));
    } catch (error) {
        console.error('Error fetching all fixed expenses:', error);
        throw new Error('Failed to retrieve the list.');
    }
}

export async function deleteFixedExpense(searchDescription: string): Promise<boolean | string> {
    try {
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: 'FixedExpenses!A:G',
        });

        const rows = response.data.values;
        if (!rows || rows.length <= 1) return false;

        let targetRowIndex = -1;
        
        for (let i = 1; i < rows.length; i++) {
            const rowDescription = rows[i][4]?.toLowerCase() || "";
            if (rowDescription.includes(searchDescription.toLowerCase())) {
                targetRowIndex = i + 1; 
                break;
            }
        }

        if (targetRowIndex === -1) return "not_found";

        await sheets.spreadsheets.values.clear({
            spreadsheetId: SPREADSHEET_ID,
            range: `FixedExpenses!A${targetRowIndex}:G${targetRowIndex}`,
        });

        return true;
    } catch (error) {
        console.error('Error deleting fixed expense:', error);
        throw new Error('Failed to delete the recurring expense.');
    }
}
export async function logBulkExpensesToSheet(expenses: any[]) {
    try {
        // THE FIX: Order this array exactly how your columns appear in Sheets!
        // Column A: Date, Column B: Amount, Column C: Currency, Column D: Category, Column E: Description
        const values = expenses.map(exp => [
            exp.date, 
            exp.amount, 
            exp.currency || 'MYR', // Fallback just in case the AI misses it
            exp.category || 'General', 
            exp.description
        ]);

        await sheets.spreadsheets.values.append({
            spreadsheetId: SPREADSHEET_ID,
            range: 'Expenses!A:E', // Make sure this spans from A to E!
            valueInputOption: 'USER_ENTERED',
            requestBody: { values },
        });

        console.log(`Successfully logged ${expenses.length} expenses in bulk!`);
    } catch (error: any) {
        console.error('Error logging bulk to Sheets:', error.message);
        throw error;
    }
}