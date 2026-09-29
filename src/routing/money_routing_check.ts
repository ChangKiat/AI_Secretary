import { applyMoneyRoutingHints, isExpenseLedger, routeByHeuristics } from './router';

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

const mixedWorkoutSupplementExpense = routeByHeuristics(
    'squat 15\nDeadlift 5\n\nOne scope myprotein\nLalaport buy waffle kayapandan butter tng rm7',
    false
);
for (const d of ['expense', 'meal', 'workout'] as const) {
    assert(
        mixedWorkoutSupplementExpense.includes(d),
        `workout + protein scoop + paid waffle should include ${d}`
    );
}

const tripLedger = `26/09/2026
Coffee black coffee 32k
Toilet Han market 2k
Yao dou 500g 170k
T-shirt 2 pcs 400k
Beer lunch with Richard 30k
Beer rm20 cash with justin

27/09/2026
Alpine coasters 250k
beer at shop 40k
Pork belly 130k

29/09/2026
Milk coffee 35k
3in 1 coffee 300k`;
assert(isExpenseLedger(tripLedger), 'dated trip list is a ledger');
assert(
    JSON.stringify(routeByHeuristics(tripLedger, false)) === JSON.stringify(['expense']),
    'trip ledger goes to expense only (no meal logs for coffee/beer lines)'
);
assert(
    JSON.stringify(applyMoneyRoutingHints(tripLedger, ['meal', 'expense'])) === JSON.stringify(['expense']),
    'planner path also drops meal for a ledger'
);

const singleVnd = routeByHeuristics('Pho bo 60k', false);
assert(singleVnd.includes('expense'), '"60k" alone is a price → expense');

const dailyMeals = routeByHeuristics('breakfast rm8\nlunch nasi lemak rm12\ndinner chicken rice rm10', false);
assert(
    dailyMeals.includes('meal') && dailyMeals.includes('expense'),
    'everyday RM meal list still logs meals'
);

for (const run of ['5k run this morning', 'ran 10k today', 'jogged 5km']) {
    assert(!routeByHeuristics(run, false).includes('expense'), `"${run}" is a distance, not a price`);
}

assert(routeByHeuristics('Grab 45,000đ', false).includes('expense'), 'đ amount is a price');

console.log('money_routing_check: ok');
