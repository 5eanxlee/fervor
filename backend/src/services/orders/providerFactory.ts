import { env } from '../../config/env';
import { FixtureOrderProvider } from './fixtureOrderProvider';
import { JupiterTriggerProvider } from './jupiterTriggerProvider';
import { OrderProvider } from './provider';

export const createOrderProvider = (): OrderProvider => {
    if (env.ORDER_MODE === 'fixture') return new FixtureOrderProvider();
    if (env.ORDER_MODE === 'live' && env.ALLOW_LIVE_SUBMISSION && env.JUPITER_API_KEY) {
        return new JupiterTriggerProvider();
    }
    throw new Error('Orders are disabled');
};
