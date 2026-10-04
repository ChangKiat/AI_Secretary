import {
    displayPaymentMethod,
    paymentMethodsMatch as match,
    resolvePaymentMethod,
    setPaymentAccountsCache,
} from './paymentMethods';
import type { PaymentAccount } from '../services/paymentAccountService';

function assert(condition: boolean, message: string) {
    if (!condition) throw new Error(message);
}

function account(
    id: number,
    name: string,
    accountType: PaymentAccount['accountType'] = 'account',
    active = true
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
        active,
    };
}

setPaymentAccountsCache([
    account(1, 'TnG'),
    account(2, 'Credit Card', 'credit'),
    account(3, 'HongLeong Infinite', 'credit'),
    account(4, 'HongLeong Platinum', 'credit'),
    account(5, 'RHB Shell Card', 'credit'),
    account(6, 'RHB World Card', 'credit'),
    account(7, 'Maybank', 'account', false),
    account(8, 'Maybank Savings'),
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

// Fuzzy matching: 3+ character prefixes only, and only when exactly one active account matches.
assert(resolvePaymentMethod('r') === null, 'r is too short to prefix-match');
assert(resolvePaymentMethod('rhb') === null, 'rhb is ambiguous (Shell / World)');
assert(resolvePaymentMethod('card') === null, 'card is ambiguous');
assert(resolvePaymentMethod('plat') === 'HongLeong Platinum', 'plat should resolve to HongLeong Platinum');
assert(resolvePaymentMethod('credit') === 'Credit Card', 'credit should resolve to Credit Card');

// Filters: an unknown filter matches only rows stored with that text, never everything.
assert(match('RHB Shell Card', 'Boost Wallet') === false, 'unknown filter must not match other accounts');
assert(match(null, 'Boost Wallet') === false, 'unknown filter must not match empty rows');
assert(match('shell', 'RHB Shell Card') === true, 'stored nickname should match its account');
assert(match('anything', '') === true, 'empty filter matches everything');

// Display keeps unresolved text (Cash, renamed or deactivated accounts) instead of dropping it.
assert(displayPaymentMethod('Cash') === 'Cash', 'unresolved value should display as stored');
assert(displayPaymentMethod('shell') === 'RHB Shell Card', 'nickname should display as its account');
assert(displayPaymentMethod('  ') === null, 'blank should display as null');

// Inactive names never resolve, and never fuzzy-match into an active account that shares a token.
assert(resolvePaymentMethod('Maybank') === null, 'inactive Maybank should not resolve to Maybank Savings');
assert(resolvePaymentMethod('maybank savings') === 'Maybank Savings', 'active exact name still resolves');
assert(resolvePaymentMethod('savings') === 'Maybank Savings', 'active fuzzy match still resolves');
assert(displayPaymentMethod('Maybank') === 'Maybank', 'inactive name should display as stored');
assert(match('Maybank', 'Maybank Savings') === false, 'inactive rows must not count toward the active account');
assert(match('Maybank', 'Maybank') === true, 'filtering by an inactive name still finds its rows');

// An alias whose target account is deactivated resolves to null, not to a fuzzy look-alike.
setPaymentAccountsCache([
    account(3, 'HongLeong Infinite', 'credit', false),
    account(4, 'HongLeong Platinum', 'credit'),
    account(5, 'RHB Shell Card', 'credit', false),
    account(9, 'Shell Card Platinum', 'credit'),
]);
assert(resolvePaymentMethod('Shell Card') === null, 'alias to an inactive account should be null');
assert(resolvePaymentMethod('HLB IF') === null, 'alias to an inactive account should be null');
assert(resolvePaymentMethod('HLB GSC') === 'HongLeong Platinum', 'alias to an active account still resolves');
assert(
    resolvePaymentMethod('shell card platinum') === 'Shell Card Platinum',
    'active exact name still resolves'
);

console.log('paymentMethods_check: ok');
