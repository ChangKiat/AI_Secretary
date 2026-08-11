import { resolvePaymentMethod, setPaymentAccountsCache } from './paymentMethods';
import type { PaymentAccount } from '../services/paymentAccountService';

function assert(condition: boolean, message: string) {
    if (!condition) throw new Error(message);
}

function account(
    id: number,
    name: string,
    accountType: PaymentAccount['accountType'] = 'account'
): PaymentAccount {
    return {
        id,
        name,
        accountType,
        initialBalance: 0,
        balanceBaselineDate: '2020-01-01',
        creditLimit: null,
        statementDay: null,
        rebateConfig: null,
        active: true,
    };
}

setPaymentAccountsCache([
    account(1, 'TnG'),
    account(2, 'RHB world credit card', 'credit'),
    account(3, 'Credit Card', 'credit'),
]);

assert(resolvePaymentMethod('TNG') === 'TnG', 'TNG should resolve to TnG');
assert(resolvePaymentMethod('touch and go') === 'TnG', 'touch and go should resolve to TnG');
assert(resolvePaymentMethod('touch  n  go') === 'TnG', 'collapsed whitespace should resolve to TnG');
assert(resolvePaymentMethod('Touch-n-Go') === 'TnG', 'touch-n-go should resolve to TnG');

assert(
    resolvePaymentMethod('world card') === 'RHB world credit card',
    'world card should resolve to RHB world credit card'
);
assert(
    resolvePaymentMethod('world credit card') === 'RHB world credit card',
    'world credit card should resolve to RHB world credit card'
);
assert(
    resolvePaymentMethod('totally fake wallet') === null,
    'unknown payment method should be null'
);

console.log('paymentMethods_check: ok');
