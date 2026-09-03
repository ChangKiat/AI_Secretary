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
    account(2, 'Credit Card', 'credit'),
    account(3, 'HongLeong Infinite', 'credit'),
    account(4, 'HongLeong Platinum', 'credit'),
    account(5, 'RHB Shell Card', 'credit'),
    account(6, 'RHB World Card', 'credit'),
]);

assert(resolvePaymentMethod('TNG') === 'TnG', 'TNG should resolve to TnG');
assert(resolvePaymentMethod('touch and go') === 'TnG', 'touch and go should resolve to TnG');
assert(resolvePaymentMethod('touch  n  go') === 'TnG', 'collapsed whitespace should resolve to TnG');
assert(resolvePaymentMethod('Touch-n-Go') === 'TnG', 'touch-n-go should resolve to TnG');

assert(
    resolvePaymentMethod('HLB infinite') === 'HongLeong Infinite',
    'HLB infinite should resolve to HongLeong Infinite'
);
assert(
    resolvePaymentMethod('HLB IF') === 'HongLeong Infinite',
    'HLB IF should resolve to HongLeong Infinite'
);
assert(
    resolvePaymentMethod('infinite') === 'HongLeong Infinite',
    'infinite should resolve to HongLeong Infinite'
);
assert(
    resolvePaymentMethod('HLB GSC') === 'HongLeong Platinum',
    'HLB GSC should resolve to HongLeong Platinum'
);
assert(
    resolvePaymentMethod('platinum') === 'HongLeong Platinum',
    'platinum should fuzzy-resolve to HongLeong Platinum'
);

assert(
    resolvePaymentMethod('Shell Card') === 'RHB Shell Card',
    'Shell Card should resolve to RHB Shell Card'
);
assert(
    resolvePaymentMethod('RHB Shell') === 'RHB Shell Card',
    'RHB Shell should resolve to RHB Shell Card'
);
assert(
    resolvePaymentMethod('shell') === 'RHB Shell Card',
    'shell should fuzzy-resolve to RHB Shell Card'
);

assert(
    resolvePaymentMethod('World Card') === 'RHB World Card',
    'World Card should resolve to RHB World Card'
);
assert(
    resolvePaymentMethod('RHB World') === 'RHB World Card',
    'RHB World should resolve to RHB World Card'
);

assert(
    resolvePaymentMethod('totally fake wallet') === null,
    'unknown payment method should be null'
);

console.log('paymentMethods_check: ok');
