import { TokenAlert } from '../../types';

export type NotificationChannel = 'telegram' | 'discord';

export type DeliveryStatus =
    | 'pending'
    | 'sending'
    | 'accepted'
    | 'processed'
    | 'delivered'
    | 'deferred'
    | 'retry_scheduled'
    | 'suppressed'
    | 'sent'
    | 'failed'
    | 'dead_lettered'
    | 'ambiguous';

export type ProviderSendResult =
    | {
        kind: 'accepted';
        providerMessageId?: string;
        providerStatus?: string;
        metadata?: Record<string, unknown>;
        rateDelayMs?: number;
        rateScope?: 'global' | 'recipient';
        rateBucket?: string;
        rateRoute?: string;
    }
    | {
        kind: 'retryable_failure';
        errorCode?: string;
        errorMessage: string;
        retryAfterMs?: number;
        metadata?: Record<string, unknown>;
        rateScope?: 'global' | 'recipient';
        rateBucket?: string;
        rateRoute?: string;
        effect: 'none' | 'unknown';
    }
    | {
        kind: 'permanent_failure';
        errorCode?: string;
        errorMessage: string;
        suppressRecipient?: boolean;
        metadata?: Record<string, unknown>;
    };

export interface AlertNotificationPayload {
    alert: TokenAlert;
    currentValue: number;
    triggeredAt: string;
}

export interface NotificationSendInput<TPayload = AlertNotificationPayload> {
    deliveryId: string;
    alertEventId: string;
    alertId: string;
    userId: string;
    recipient: string;
    recipientHash: string;
    payload: TPayload;
    idempotencyKey: string;
    requestKey: string;
    locale: string;
    timezone: string;
}

export interface NotificationProvider<TPayload = AlertNotificationPayload> {
    channel: NotificationChannel;
    providerName: string;
    isConfigured(): boolean;
    send(input: NotificationSendInput<TPayload>): Promise<ProviderSendResult>;
}

export interface ChannelPreferenceResolution {
    channel: NotificationChannel;
    enabled: boolean;
    verified: boolean;
    suppressed: boolean;
    recipient?: string;
    recipientHash?: string;
    locale: string;
    timezone: string;
    reason?: string;
}
