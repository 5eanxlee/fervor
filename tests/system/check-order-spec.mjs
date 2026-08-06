import {
    clone,
    compileSchema,
    parse,
    resolveRoot,
} from './spec-utils.mjs';

const schemaPath = resolveRoot('tests', 'contracts', 'order-capabilities.schema.json');
const examplePath = resolveRoot('tests', 'contracts', 'order-capabilities.example.json');

const schema = parse(schemaPath);
const example = parse(examplePath);
const { validate, explain } = compileSchema(schema);

if (!validate(example)) {
    throw new Error(`Capability example is invalid:\n${explain()}`);
}

const invalidCases = [
    {
        name: 'activation cannot use generic reconciliation retry',
        value: () => {
            const value = clone(example);
            value.mutations.activate.retry = 'reconcile_first';
            return value;
        },
    },
    {
        name: 'Trigger actions cannot broadcast directly',
        value: () => {
            const value = clone(example);
            value.custody.directBroadcast = true;
            return value;
        },
    },
    {
        name: 'shared custody requires a manager',
        value: () => {
            const value = clone(example);
            value.custody.manager = null;
            return value;
        },
    },
    {
        name: 'ready capabilities require freshness timestamps',
        value: () => {
            const value = clone(example);
            value.expiresAt = null;
            return value;
        },
    },
    {
        name: 'live Jupiter readiness requires a provider probe',
        value: () => {
            const value = clone(example);
            value.source = 'adapter_static';
            return value;
        },
    },
    {
        name: 'disabled mode cannot expose mutations',
        value: () => {
            const value = clone(example);
            value.mode = 'disabled';
            return value;
        },
    },
    {
        name: 'unknown fields fail closed',
        value: () => ({ ...clone(example), speculativeFeature: true }),
    },
];

for (const test of invalidCases) {
    if (validate(test.value())) {
        throw new Error(`Unsafe capability case was accepted: ${test.name}`);
    }
}

console.log(`order contract: 1 valid example, ${invalidCases.length} negative capability cases`);
