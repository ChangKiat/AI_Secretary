import { burnFromReportedCalories, estimateBurn } from './burnCalculator';

function assert(condition: boolean, message: string) {
    if (!condition) throw new Error(message);
}

const reported = burnFromReportedCalories(229);
assert(reported.caloriesBurned === 229, 'reported calories should be kept');
assert(reported.fatBurnG > 0, 'fat burn should derive from reported calories');

const estimated = estimateBurn('plank', 0.75, 3, undefined, undefined, 70);
assert(estimated != null && estimated.caloriesBurned < 229, 'plank estimate should be below machine 229');

console.log('burnCalculator_check: ok');
