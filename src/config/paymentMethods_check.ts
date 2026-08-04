import { resolvePaymentMethod, setPaymentAccountsCache } from './paymentMethods';
import type { PaymentAccount } from '../services/paymentAccountService';

function assert(condition: boolean, message: string) {
    if (!condition) throw new Error(message);
}

const tng: PaymentAccount = {
    id: 1,
    name: 'TnG',
    accountType: 'account',
    initialBalance: 0,
    balanceBaselineDate: '2020-01-01',
    creditLimit: null,
    statementDay: null,
    rebateConfig: null,
    active: true,
};

setPaymentAccountsCache([tng]);

assert(resolvePaymentMethod('TNG') === 'TnG', 'TNG should resolve to TnG');
assert(resolvePaymentMethod('touch and go') === 'TnG', 'touch and go should resolve to TnG');
assert(resolvePaymentMethod('touch  n  go') === 'TnG', 'collapsed whitespace should resolve to TnG');
assert(resolvePaymentMethod('Touch-n-Go') === 'TnG', 'touch-n-go should resolve to TnG');

console.log('paymentMethods_check: ok');
