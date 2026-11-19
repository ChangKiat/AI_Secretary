import { strict as assert } from 'node:assert';
import { isReceiptMealQuestion } from './receiptReply';

// Exact production wording: the reply arrived hours later, after session expiry.
assert(isReceiptMealQuestion(`This receipt from Mr Peppery Rice has one food item:
1. Chic Yee Mee (W) Eg (RM13)
Is this yours, or did you share it? If you shared it, tell me how many people ate it.`));
assert(isReceiptMealQuestion('Which items are yours?'));
assert(isReceiptMealQuestion('1. Rice (RM13)\n2. Tea (RM3)\nWhich did you eat?'));
assert(isReceiptMealQuestion('This receipt has rice. How many people ate it?'));
assert(!isReceiptMealQuestion('Receipt total RM13. Which account did you pay with?'));
assert(!isReceiptMealQuestion('Logged #1465\nAmount: MYR 13\nCategory: Food'));
assert(!isReceiptMealQuestion('Is this yours?'));
console.log('Receipt reply routing checks passed.');
