import { applyMoneyRoutingHints } from '../routing/router';

function assert(condition: boolean, message: string) {
    if (!condition) throw new Error(message);
}

const withPrice = applyMoneyRoutingHints('chinese kopi RM13 TNG', ['meal', 'chat']);
assert(withPrice.includes('expense'), 'price+TNG should add expense');
assert(!withPrice.includes('chat'), 'price+TNG should drop chat');
assert(withPrice.includes('meal'), 'price+TNG should keep meal');

const chatOnly = applyMoneyRoutingHints('paid via TNG', ['chat']);
assert(
    JSON.stringify(chatOnly) === JSON.stringify(['expense']),
    'payment-only chat should become expense'
);

const plainFood = applyMoneyRoutingHints('had nasi lemak', ['meal']);
assert(
    JSON.stringify(plainFood) === JSON.stringify(['meal']),
    'plain food without price should be unchanged'
);

console.log('money_routing_check: ok');
