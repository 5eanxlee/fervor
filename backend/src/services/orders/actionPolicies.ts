import type {
    AttemptHttpClass,
    AttemptMethod,
    OrderActionKind,
} from '../../types';
import { actionKinds, orderPolicy } from '../../contracts/orderPolicy';

export interface DispatchRule {
    methods: ReadonlySet<AttemptMethod>;
    body: boolean;
    blob: boolean;
}

const buildRules = (): Record<OrderActionKind, DispatchRule> => {
    const rules = {} as Record<OrderActionKind, DispatchRule>;
    for (const kind of actionKinds) {
        const rule = orderPolicy.dispatch[kind];
        rules[kind] = {
            methods: new Set(rule.methods as AttemptMethod[]),
            body: rule.body,
            blob: rule.blob,
        };
    }
    return rules;
};

export const dispatchRules = buildRules();

export const matchesStatus = (kind: AttemptHttpClass, status: number): boolean => {
    const rule = orderPolicy.http[kind];
    const excluded = rule.exclude as number[];
    return rule.ranges.some(([low, high]) => status >= low && status <= high)
        && !excluded.includes(status);
};
