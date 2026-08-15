import 'dotenv/config';
import { listActivePaymentAccounts } from '../src/services/paymentAccountService';

async function main() {
    const accounts = await listActivePaymentAccounts();
    console.log(JSON.stringify(accounts.map((a) => ({ name: a.name, type: a.accountType })), null, 2));
    process.exit(0);
}

main();
