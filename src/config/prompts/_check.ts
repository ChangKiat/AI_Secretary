import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';
import { SchemaType } from '@google/generative-ai';
import { buildPlannerInstruction, buildDomainInstruction, SpecialistDomain } from './index';
import { basePrompt } from './base';
import { getDomainDeclarations, getPlannerDeclarations, routeRequestDeclaration } from '../../tools/tools';
import { getExpenseCategoryNames } from '../expenseCategories';
import { routeByHeuristics } from '../../routing/router';

const DOMAINS: SpecialistDomain[] = ['expense', 'meal', 'calendar', 'workout'];

function assert(condition: boolean, message: string) {
    if (!condition) throw new Error(message);
}

const planner = buildPlannerInstruction();
assert(planner.length > 0, 'plannerPrompt must be non-empty');

for (const domain of DOMAINS) {
    const instruction = buildDomainInstruction(domain, getExpenseCategoryNames());
    assert(instruction.length > 0, `${domain} prompt must be non-empty`);
}

const plannerTools = getPlannerDeclarations();
assert(plannerTools.length === 1, 'planner should have one tool');
assert(plannerTools[0].name === 'route_request', 'planner tool must be route_request');

const routeDomains = routeRequestDeclaration.parameters?.properties?.domains;
assert(routeDomains?.type === SchemaType.ARRAY, 'route_request.domains must be an array');

const namesByDomain = Object.fromEntries(
    DOMAINS.map((d) => [d, getDomainDeclarations(d).map((t: { name: string }) => t.name)])
) as Record<SpecialistDomain, string[]>;

for (let i = 0; i < DOMAINS.length; i++) {
    for (let j = i + 1; j < DOMAINS.length; j++) {
        const a = DOMAINS[i];
        const b = DOMAINS[j];
        const overlap = namesByDomain[a].filter(
            (n) => namesByDomain[b].includes(n) && n !== 'update_user_settings'
        );
        assert(overlap.length === 0, `tool overlap between ${a} and ${b}: ${overlap.join(', ')}`);
    }
}

assert(
    planner.includes('Restaurant') && planner.includes('expense AND meal'),
    'planner must route restaurant receipts to expense AND meal'
);
assert(
    planner.includes('payment caption') && planner.includes('never chat alone'),
    'planner must not chat-only on receipt images with payment captions'
);
assert(
    planner.includes('chinese kopi') && planner.includes('never chat'),
    'planner must route food+RM+TNG to expense AND meal, never chat'
);
assert(
    planner.includes('payment method') && planner.includes('include expense'),
    'planner must never chat alone on price/payment messages'
);
assert(
    planner.includes('statement') && planner.toLowerCase().includes('expense only'),
    'planner must keep bank statements expense-only'
);

const expensePrompt = buildDomainInstruction('expense', getExpenseCategoryNames());
assert(
    expensePrompt.includes('grand total') || expensePrompt.includes('RESTAURANT RECEIPT'),
    'expense prompt must log restaurant grand total only'
);
assert(
    expensePrompt.includes('I only eat 3rd item') && expensePrompt.includes('NEVER changes the amount'),
    'expense prompt must log the full receipt total even when the user ate only some items'
);

const mealDomainPrompt = buildDomainInstruction('meal', getExpenseCategoryNames());
assert(
    mealDomainPrompt.includes('RESTAURANT RECEIPT') &&
        mealDomainPrompt.includes('Which items are yours?'),
    'meal prompt must support receipt item selection'
);
assert(
    mealDomainPrompt.includes('all eat by me') && mealDomainPrompt.includes('2 person eat'),
    'meal prompt must handle "all mine" and shared (divide by N) receipt answers'
);
assert(
    mealDomainPrompt.includes('MONEY') && mealDomainPrompt.includes('lack financial tools'),
    'meal prompt must ignore price/payment and never discuss financial tools'
);

const workoutDomainPrompt = buildDomainInstruction('workout', getExpenseCategoryNames());
assert(
    workoutDomainPrompt.includes('MACHINE SCREEN') &&
        workoutDomainPrompt.includes('caloriesBurned'),
    'workout prompt must log machine screen calories with caption exercises'
);
assert(
    workoutDomainPrompt.includes('SUGGEST') && workoutDomainPrompt.includes('horizon week'),
    'workout prompt must call suggest_workout for training ideas and weekly plans'
);
assert(
    mealDomainPrompt.includes('SUGGEST') && mealDomainPrompt.includes('Malaysian'),
    'meal prompt must call suggest_meal with Malaysian food preference'
);
assert(
    planner.includes('plan my week') && planner.includes('workout AND meal'),
    'planner must route weekly fitness+meal plan to workout AND meal'
);
assert(
    planner.includes('machine results') || planner.includes('machine screen'),
    'planner must route machine screen + caption to workout'
);

const calendarTools = namesByDomain.calendar;
assert(
    calendarTools.includes('reschedule_calendar_event') &&
        calendarTools.includes('cancel_calendar_event'),
    'calendar must include reschedule_calendar_event and cancel_calendar_event'
);

// 3.7-3.9: profile stats + BMR, step logging, and the two labelled "calories burned" figures.
const declarationOf = (domain: SpecialistDomain, name: string) =>
    getDomainDeclarations(domain).find((t) => t.name === name);
assert(
    namesByDomain.workout.includes('log_steps') &&
        (['expense', 'financeConfig', 'meal', 'calendar'] as const).every((d) => !declarationOf(d, 'log_steps')),
    'log_steps must be declared in the workout domain only'
);
const userSettingsProps = declarationOf('meal', 'update_user_settings')?.parameters?.properties ?? {};
assert(
    ['bodyWeightKg', 'heightCm', 'age', 'sex'].every((k) => k in userSettingsProps),
    'update_user_settings must accept bodyWeightKg, heightCm, age and sex'
);
assert(
    JSON.stringify((userSettingsProps.sex as { enum?: string[] } | undefined)?.enum) === '["male","female"]',
    'update_user_settings.sex must be the male/female enum'
);
assert(
    mealDomainPrompt.includes('heightCm') && workoutDomainPrompt.includes('heightCm'),
    'meal and workout prompts must list the profile fields of update_user_settings'
);
assert(
    planner.includes('profile stats (height, age, sex)'),
    'planner must route profile stats (height, age, sex) to meal'
);
assert(
    /step counts[^\n]*log_steps[^\n]*never log_workout/i.test(workoutDomainPrompt),
    'workout prompt must send step counts to log_steps, never log_workout'
);
assert(
    planner.includes('step counts') && planner.includes('10k steps'),
    'planner must route daily step counts (with an example) to workout'
);
for (const stepsText of ['9,800 steps today', '10k steps yesterday']) {
    const routed = routeByHeuristics(stepsText, false);
    assert(
        routed.includes('workout') && !routed.includes('expense'),
        `heuristic routing must send "${stepsText}" to workout, not expense (got ${routed.join(', ')})`
    );
}
const workoutSummaryDescription = declarationOf('workout', 'get_workout_summary')?.description ?? '';
assert(
    workoutSummaryDescription.includes('workoutCaloriesBurned') &&
        workoutSummaryDescription.includes('totalEnergyBurned'),
    'get_workout_summary must describe the workout-only and total energy burned figures'
);
assert(
    workoutDomainPrompt.includes('workoutCaloriesBurned') &&
        workoutDomainPrompt.includes('totalEnergyBurned') &&
        workoutDomainPrompt.includes('bmrHint'),
    'workout prompt must reply with both labelled burn figures and the BMR hint'
);

// 3.13: Dashboard-only features are named in every specialist's base rules, the capabilities rule
// defers to them, and nothing Telegram now has a tool for is listed as Dashboard-only.
const dashboardOnlyRule = basePrompt.split('\n').find((line) => line.startsWith('6. DASHBOARD-ONLY')) ?? '';
assert(
    dashboardOnlyRule.includes('car service') && dashboardOnlyRule.includes('FD') && dashboardOnlyRule.includes('loan terms'),
    'base prompt rule 6 must list the Dashboard-only features'
);
assert(
    /NEVER claim you lack access to anything your tools cover\. The only exception is rule 6/.test(basePrompt),
    'base prompt CAPABILITIES rule must defer to the DASHBOARD-ONLY rule'
);
for (const supported of ['unit trust', 'exchange', 'create', 'step', 'budget', 'fixed bill', 'transfer fee', 'interest schedule', 'weight']) {
    assert(
        !dashboardOnlyRule.toLowerCase().includes(supported),
        `base prompt rule 6 must not list "${supported}" as Dashboard-only: Telegram has a tool for it`
    );
}
const financeConfigPrompt = buildDomainInstruction('financeConfig', getExpenseCategoryNames());
assert(
    expensePrompt.includes('Car tab') && expensePrompt.includes('double-counts') && financeConfigPrompt.includes('rebate/cashback'),
    'expense and financeConfig prompts must say what to log for Dashboard-only features'
);
// The share/ETF/FD cash leg is an Account transfer: an Investment top-up expense plus the Dashboard
// buy's own Investment expense would double-count the spending.
const sharesRule = expensePrompt.split('\n').find((line) => line.startsWith('- SHARES, ETFs, FDs')) ?? '';
assert(
    sharesRule.includes('Account transfer') && !sharesRule.includes('INVESTMENT TOP-UPS'),
    'expense SHARES rule must log the cash leg as an Account transfer, never as an INVESTMENT TOP-UP'
);
// The model's own text is dropped once a tool is called, so the Dashboard note rides on the tool call.
for (const tool of ['log_expense', 'log_income']) {
    assert(
        'dashboardNote' in (declarationOf('expense', tool)?.parameters?.properties ?? {}),
        `${tool} must accept dashboardNote (3.13 Dashboard-only note)`
    );
}
assert(
    sharesRule.includes('dashboardNote') && /- CAR SERVICE[^\n]*dashboardNote/.test(expensePrompt),
    'expense CAR SERVICE and SHARES rules must pass the Dashboard note in dashboardNote'
);

// -------------------------------------------------------------------------------------------------
// 3.17: a declared tool whose handler relays the model's follow-up text must be in
// TOOLS_READING_MODEL_REPLY (toolHandler.ts). runChatTurn (index.ts) defers functionResponses unless a
// called tool is in that set, and a deferred turn's chat.sendMessage returns empty text, so a handler
// missing from the set replies "" on every turn.
//
// Heuristic: a static TypeScript AST scan of every .ts file under src/tools/ (comments and strings
// never match).
//  - Reading the reply = a zero-argument call `<expr>.response.text()` or `response.text()`.
//  - A named function under src/tools/ (declaration, `const f = (...) => ...`, method) reads the reply
//    when its body does, or when it references another reading function by name, either bare
//    (`relay(...)`, `{ tool: relay }`) or as a called method (`helpers.relay(...)`). This repeats to a
//    fixpoint, so a handler split across helper functions or sibling files is still caught.
//  - A tool's handler (files other than tools.ts): the then-branch of `if (... x.name === 'tool' ...)`
//    (either operand order, a `...Name` variable, `||` combinations, `['a', 'b'].includes(x.name)`),
//    the statements of `case 'tool':` in `switch (x.name)` (empty cases fall through to the next
//    non-empty one), and the value of a `tool:` property in an object literal (handler maps). Inside a
//    handler, a nested `if` that tests only other tools' names is skipped (its else branch is not).
//  - Every declared tool must have a handler this scan recognises; if not, extend the heuristic.
// Blind spots: relay helpers outside src/tools/, dispatch on a name computed at runtime, and reading
// the text through an alias (`const { response } = r; const t = response; t.text()`).
// -------------------------------------------------------------------------------------------------

function isModelReplyRead(node: ts.Node): boolean {
    if (!ts.isCallExpression(node) || node.arguments.length > 0) return false;
    const callee = node.expression;
    if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== 'text') return false;
    const receiver = callee.expression;
    return (
        (ts.isPropertyAccessExpression(receiver) && receiver.name.text === 'response') ||
        (ts.isIdentifier(receiver) && receiver.text === 'response')
    );
}

/** `call.name`, `x.name`, or a variable such as `resolvedName` / `toolName`. */
function isToolNameExpr(node: ts.Node): boolean {
    return (
        (ts.isPropertyAccessExpression(node) && node.name.text === 'name') ||
        (ts.isIdentifier(node) && /name$/i.test(node.text))
    );
}

/** The function name an identifier refers to: bare use or called method, never a declared name. */
function referencedName(node: ts.Node): string | undefined {
    if (!ts.isIdentifier(node)) return undefined;
    const parent = node.parent;
    if (ts.isPropertyAccessExpression(parent) && parent.name === node) {
        return ts.isCallExpression(parent.parent) && parent.parent.expression === parent
            ? node.text
            : undefined;
    }
    const declares =
        (ts.isFunctionDeclaration(parent) ||
            ts.isVariableDeclaration(parent) ||
            ts.isMethodDeclaration(parent) ||
            ts.isPropertyAssignment(parent) ||
            ts.isParameter(parent)) &&
        parent.name === node;
    return declares ? undefined : node.text;
}

function findNode<T extends ts.Node>(root: ts.Node, test: (node: ts.Node) => node is T): T | undefined {
    const visit = (node: ts.Node): T | undefined => (test(node) ? node : ts.forEachChild(node, visit));
    return visit(root);
}

function scanModelReplyReaders(
    handlerFiles: ts.SourceFile[],
    helperFiles: ts.SourceFile[],
    tools: Set<string>
): { handlers: Map<string, ts.Node[]>; readers: Set<string> } {
    const testedTools = (condition: ts.Node): string[] => {
        const found: string[] = [];
        const visit = (node: ts.Node) => {
            if (
                ts.isBinaryExpression(node) &&
                (node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
                    node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsToken)
            ) {
                for (const [a, b] of [
                    [node.left, node.right],
                    [node.right, node.left],
                ]) {
                    if (isToolNameExpr(a) && ts.isStringLiteralLike(b)) found.push(b.text);
                }
            } else if (
                ts.isCallExpression(node) &&
                ts.isPropertyAccessExpression(node.expression) &&
                node.expression.name.text === 'includes' &&
                ts.isArrayLiteralExpression(node.expression.expression) &&
                node.arguments.length === 1 &&
                isToolNameExpr(node.arguments[0])
            ) {
                for (const el of node.expression.expression.elements) {
                    if (ts.isStringLiteralLike(el)) found.push(el.text);
                }
            }
            ts.forEachChild(node, visit);
        };
        visit(condition);
        return found.filter((name) => tools.has(name));
    };

    const readingFunctions = new Set<string>();
    const readsReply = (root: ts.Node, tool?: string): boolean => {
        let found = false;
        const visit = (node: ts.Node) => {
            if (found) return;
            const ref = referencedName(node);
            if (isModelReplyRead(node) || (ref !== undefined && readingFunctions.has(ref))) {
                found = true;
                return;
            }
            if (tool && ts.isIfStatement(node)) {
                const tested = testedTools(node.expression);
                if (tested.length > 0 && !tested.includes(tool)) {
                    if (node.elseStatement) visit(node.elseStatement);
                    return;
                }
            }
            ts.forEachChild(node, visit);
        };
        visit(root);
        return found;
    };

    const functionBodies = new Map<string, ts.Node[]>();
    for (const sf of helperFiles) {
        const visit = (node: ts.Node) => {
            let name: string | undefined;
            let body: ts.Node | undefined;
            if (
                (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) &&
                node.name &&
                ts.isIdentifier(node.name)
            ) {
                name = node.name.text;
                body = node.body;
            } else if (
                ts.isVariableDeclaration(node) &&
                ts.isIdentifier(node.name) &&
                node.initializer &&
                (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
            ) {
                name = node.name.text;
                body = node.initializer.body;
            }
            if (name && body) functionBodies.set(name, [...(functionBodies.get(name) ?? []), body]);
            ts.forEachChild(node, visit);
        };
        visit(sf);
    }
    for (let changed = true; changed; ) {
        changed = false;
        for (const [name, bodies] of functionBodies) {
            if (!readingFunctions.has(name) && bodies.some((body) => readsReply(body))) {
                readingFunctions.add(name);
                changed = true;
            }
        }
    }

    const handlers = new Map<string, ts.Node[]>();
    const addHandler = (tool: string, body: ts.Node | undefined) => {
        if (body) handlers.set(tool, [...(handlers.get(tool) ?? []), body]);
    };
    for (const sf of handlerFiles) {
        const visit = (node: ts.Node) => {
            if (ts.isIfStatement(node)) {
                for (const tool of testedTools(node.expression)) addHandler(tool, node.thenStatement);
            } else if (ts.isSwitchStatement(node) && isToolNameExpr(node.expression)) {
                let pending: string[] = [];
                for (const clause of node.caseBlock.clauses) {
                    if (
                        ts.isCaseClause(clause) &&
                        ts.isStringLiteralLike(clause.expression) &&
                        tools.has(clause.expression.text)
                    ) {
                        pending.push(clause.expression.text);
                    }
                    if (clause.statements.length > 0) {
                        for (const tool of pending) clause.statements.forEach((s) => addHandler(tool, s));
                        pending = [];
                    }
                }
            } else if (
                (ts.isPropertyAssignment(node) ||
                    ts.isMethodDeclaration(node) ||
                    ts.isShorthandPropertyAssignment(node)) &&
                ts.isObjectLiteralExpression(node.parent) &&
                (ts.isIdentifier(node.name) || ts.isStringLiteralLike(node.name)) &&
                tools.has(node.name.text)
            ) {
                addHandler(
                    node.name.text,
                    ts.isPropertyAssignment(node)
                        ? node.initializer
                        : ts.isMethodDeclaration(node)
                          ? node.body
                          : node.name
                );
            }
            ts.forEachChild(node, visit);
        };
        visit(sf);
    }

    const readers = new Set(
        [...handlers]
            .filter(([tool, bodies]) => bodies.some((body) => readsReply(body, tool)))
            .map(([tool]) => tool)
    );
    return { handlers, readers };
}

// The heuristic itself, on a fixture: helpers, method calls, nested branches, switch, handler map.
const replyFixture = ts.createSourceFile(
    'fixture.ts',
    [
        'async function relay(chat, ctx) { const r = await chat.sendMessage([]); await ctx.reply(r.response.text()); }',
        'const relayLater = async (chat, ctx) => relay(chat, ctx);',
        'const helpers = { relay };',
        'async function handle(call, chat, ctx) {',
        "    if (call.name === 'a_tool') { await relayLater(chat, ctx); }",
        "    else if (call.name === 'b_tool' || call.name === 'c_tool') {",
        "        if (call.name === 'c_tool') { await helpers.relay(chat, ctx); }",
        '        await chat.sendMessage([]); // response.text() in a comment does not count',
        '    }',
        "    switch (call.name) { case 'd_tool': case 'e_tool': return relay(chat, ctx); case 'f_tool': return 'f'; }",
        '}',
        "const HANDLERS = { g_tool: relay, h_tool: async () => 'h', 'i_tool': () => 'response.text()' };",
    ].join('\n'),
    ts.ScriptTarget.Latest,
    true
);
const fixtureTools = new Set(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'].map((t) => `${t}_tool`));
const fixtureScan = scanModelReplyReaders([replyFixture], [replyFixture], fixtureTools);
assert(
    fixtureScan.handlers.size === fixtureTools.size,
    `3.17 scan self-test: handlers found for ${[...fixtureScan.handlers.keys()].join(', ')}`
);
assert(
    [...fixtureScan.readers].sort().join(',') === 'a_tool,c_tool,d_tool,e_tool,g_tool',
    `3.17 scan self-test: readers detected ${[...fixtureScan.readers].sort().join(', ')}`
);

const TOOLS_DIR = path.resolve(__dirname, '../../tools');
function listTsFiles(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) return listTsFiles(full);
        return /\.ts$/.test(entry.name) && !/(\.d|_check)\.ts$/.test(entry.name) ? [full] : [];
    });
}
const toolSourceFiles = listTsFiles(TOOLS_DIR).map((file) =>
    ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
);
const handlerSourceFiles = toolSourceFiles.filter((sf) => path.basename(sf.fileName) !== 'tools.ts');

/** The string literals of `const <variable> = new Set([...])` in the handler files. */
function stringSetLiteral(variable: string): Set<string> {
    const isDeclaration = (node: ts.Node): node is ts.VariableDeclaration =>
        ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === variable;
    const declaration = handlerSourceFiles
        .map((sf) => findNode(sf, isDeclaration))
        .find((d): d is ts.VariableDeclaration => d !== undefined);
    if (!declaration) throw new Error(`${variable} not found under src/tools`);
    const init = declaration.initializer;
    const list = init && ts.isNewExpression(init) ? init.arguments?.[0] : undefined;
    if (!list || !ts.isArrayLiteralExpression(list)) {
        throw new Error(`${variable} must stay new Set([...string literals]) for prompts/_check`);
    }
    const nonLiteral = list.elements.filter((el) => !ts.isStringLiteralLike(el));
    assert(
        nonLiteral.length === 0,
        `${variable} must list string literals only for prompts/_check; found ${nonLiteral.map((el) => el.getText()).join(', ')}`
    );
    return new Set(list.elements.map((el) => (el as ts.StringLiteralLike).text));
}

const ALL_SPECIALIST_DOMAINS: SpecialistDomain[] = ['expense', 'financeConfig', 'meal', 'calendar', 'workout'];
const declaredTools = new Set(
    ALL_SPECIALIST_DOMAINS.flatMap((d) => getDomainDeclarations(d).map((t: { name: string }) => t.name))
);
const knownToolNames = stringSetLiteral('KNOWN_TOOL_NAMES');
const toolsReadingModelReply = stringSetLiteral('TOOLS_READING_MODEL_REPLY');
const replyScan = scanModelReplyReaders(handlerSourceFiles, toolSourceFiles, declaredTools);

const notKnown = [...declaredTools].filter((t) => !knownToolNames.has(t));
assert(notKnown.length === 0, `declared tools missing from KNOWN_TOOL_NAMES (toolHandler.ts): ${notKnown.join(', ')}`);
const undeclaredReaders = [...toolsReadingModelReply].filter((t) => !declaredTools.has(t));
assert(
    undeclaredReaders.length === 0,
    `TOOLS_READING_MODEL_REPLY lists tools no domain declares: ${undeclaredReaders.join(', ')}`
);
const noHandler = [...declaredTools].filter((t) => !replyScan.handlers.has(t));
assert(
    noHandler.length === 0,
    `no handler found for declared tools ${noHandler.join(', ')}; extend the 3.17 scan in prompts/_check.ts if dispatch changed`
);
const unregisteredReaders = [...replyScan.readers].filter((t) => !toolsReadingModelReply.has(t));
assert(
    unregisteredReaders.length === 0,
    `handlers relay the model reply (response.text()) but are missing from TOOLS_READING_MODEL_REPLY (toolHandler.ts): ${unregisteredReaders.join(', ')}`
);
const staleReaders = [...toolsReadingModelReply].filter((t) => !replyScan.readers.has(t));
if (staleReaders.length > 0) {
    console.warn(
        `prompts/_check: TOOLS_READING_MODEL_REPLY entries whose handler no longer reads the model reply (harmless; their responses are never deferred): ${staleReaders.join(', ')}`
    );
}

console.log('prompts/_check: ok');
