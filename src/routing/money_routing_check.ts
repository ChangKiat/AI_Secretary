import { applyMoneyRoutingHints, routeByHeuristics } from './router';

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

const dual = routeByHeuristics('i eat chicken rice today RM10 with TNG', false);
assert(dual.includes('expense'), 'chicken rice+RM+TNG should include expense');
assert(dual.includes('meal'), 'chicken rice+RM+TNG should include meal');

const mealOnly = routeByHeuristics('had nasi lemak', false);
assert(
    JSON.stringify(mealOnly) === JSON.stringify(['meal']),
    'plain food should be meal only'
);

const expenseOnly = routeByHeuristics('paid via TNG', false);
assert(
    JSON.stringify(expenseOnly) === JSON.stringify(['expense']),
    'payment-only should be expense only'
);

const workout = routeByHeuristics('bench press 3x10', false);
assert(workout.includes('workout'), 'bench press 3x10 should be workout');

const photoWithPaymentCaption = routeByHeuristics('tng rm14', true);
assert(
    photoWithPaymentCaption.includes('expense'),
    'photo + payment-only caption should include expense'
);
assert(
    photoWithPaymentCaption.includes('meal'),
    'photo + payment-only caption should also include meal (caption alone cannot rule out food)'
);

console.log('money_routing_check: ok');
