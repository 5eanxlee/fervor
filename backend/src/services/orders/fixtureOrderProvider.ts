import crypto from 'crypto';
import { OrderAuth, OrderAuthType, OrderChallenge, OrderRequest, OrderUpdate } from '../../types';
import {
    OrderProvider,
    ProviderActiveOrder,
    ProviderCancelledOrder,
    ProviderCancelOrder,
    ProviderPreparedOrder,
} from './provider';

const digest = (value: string): string => crypto.createHash('sha256').update(value).digest('hex');

export class FixtureOrderProvider implements OrderProvider {
    readonly name = 'fixture' as const;
    readonly requiresAuth = false;
    readonly custody = 'none' as const;

    async challenge(walletAddress: string, type: OrderAuthType): Promise<OrderChallenge> {
        if (type === 'transaction') {
            return { type, transaction: Buffer.from(`Fixture order authorization for ${walletAddress}`).toString('base64') };
        }
        return { type, challenge: `Fixture order authorization for ${walletAddress}` };
    }

    async verify(walletAddress: string, auth: OrderAuth): Promise<string> {
        const proof = auth.type === 'message' ? auth.signature : auth.signedTransaction;
        return `fixture_${digest(`${walletAddress}:${proof}`).slice(0, 32)}`;
    }

    async prepare(request: OrderRequest): Promise<ProviderPreparedOrder> {
        const depositRequestId = `fixture_${digest(JSON.stringify(request)).slice(0, 24)}`;
        return {
            provider: this.name,
            depositRequestId,
            transaction: Buffer.from(JSON.stringify({ depositRequestId, request })).toString('base64'),
            receiverAddress: request.walletAddress,
            inputAccount: request.walletAddress,
            outputAccount: request.orderType === 'otoco' ? request.walletAddress : undefined,
        };
    }

    async activate(request: OrderRequest, depositRequestId: string): Promise<ProviderActiveOrder> {
        return {
            providerOrderId: `order_${digest(`${depositRequestId}:${request.clientOrderId}`).slice(0, 24)}`,
            state: 'open',
            depositSignature: `fixture_${digest(depositRequestId).slice(0, 48)}`,
            rawState: 'fixture_open',
        };
    }

    async cancel(providerOrderId: string): Promise<ProviderCancelOrder> {
        const requestId = `cancel_${digest(providerOrderId).slice(0, 24)}`;
        return {
            requestId,
            transaction: Buffer.from(JSON.stringify({ requestId, providerOrderId })).toString('base64'),
        };
    }

    async update(_providerOrderId: string, _input: OrderUpdate): Promise<void> {
        return undefined;
    }

    async confirmCancel(providerOrderId: string, cancelRequestId: string): Promise<ProviderCancelledOrder> {
        return {
            state: 'cancelled',
            signature: `fixture_${digest(`${providerOrderId}:${cancelRequestId}`).slice(0, 48)}`,
            rawState: 'fixture_cancelled',
        };
    }
}
