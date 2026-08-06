import {
    DecryptCommand,
    DescribeKeyCommand,
    GenerateDataKeyCommand,
    KMSClient,
    type KMSClientConfig,
} from '@aws-sdk/client-kms';
import { env } from '../../config/env';

export type KeyContext = Readonly<Record<string, string>>;

export interface TxDataKey {
    plaintext: Buffer;
    wrapped: Buffer;
    keyId: string;
}

export interface TxKeyProvider {
    generate(context: KeyContext): Promise<TxDataKey>;
    unwrap(wrapped: Buffer, keyId: string, context: KeyContext): Promise<Buffer>;
}

export type TxKeyFailure = 'invalid' | 'unavailable';

export class TxKeyError extends Error {
    constructor(
        message: string,
        readonly kind: TxKeyFailure,
        readonly cause?: unknown
    ) {
        super(message);
        this.name = 'TxKeyError';
    }
}

const unavailable = new Set([
    'AbortError',
    'DependencyTimeoutException',
    'KMSInternalException',
    'ServiceUnavailableException',
    'ThrottlingException',
    'TimeoutError',
]);

const networkCodes = new Set([
    'EAI_AGAIN',
    'ECONNREFUSED',
    'ECONNRESET',
    'EHOSTUNREACH',
    'ENETUNREACH',
    'ETIMEDOUT',
]);

const keyFailure = (error: unknown): TxKeyFailure => {
    const issue = error as {
        name?: string;
        code?: string;
        $retryable?: unknown;
        $metadata?: { httpStatusCode?: number };
    };
    const status = issue?.$metadata?.httpStatusCode;
    return unavailable.has(issue?.name ?? '')
        || networkCodes.has(issue?.code ?? '')
        || issue?.$retryable !== undefined
        || (status !== undefined && status >= 500)
        ? 'unavailable'
        : 'invalid';
};

interface KmsSender {
    send(command: GenerateDataKeyCommand, options?: { abortSignal?: AbortSignal }): Promise<{
        Plaintext?: Uint8Array;
        CiphertextBlob?: Uint8Array;
        KeyId?: string;
    }>;
    send(command: DecryptCommand, options?: { abortSignal?: AbortSignal }): Promise<{
        Plaintext?: Uint8Array;
        KeyId?: string;
    }>;
    send(command: DescribeKeyCommand, options?: { abortSignal?: AbortSignal }): Promise<{
        KeyMetadata?: { Arn?: string; KeyId?: string };
    }>;
}

const copyKey = (value: Uint8Array | undefined): Buffer | undefined => {
    if (!value) return undefined;
    const result = Buffer.from(value);
    value.fill(0);
    return result;
};

export class AwsTxKeyProvider implements TxKeyProvider {
    private readonly client: KmsSender;
    private readonly allowedIds: readonly string[];
    private trust?: Promise<{ current: string; allowed: ReadonlySet<string> }>;

    constructor(
        private readonly keyId: string,
        client?: KmsSender,
        config: KMSClientConfig = {},
        private readonly timeoutMs = env.TX_KMS_TIMEOUT_MS,
        allowedIds: readonly string[] = [keyId]
    ) {
        if (!keyId.trim() || keyId.length > 2048) {
            throw new TxKeyError('AWS KMS key identifier is invalid', 'invalid');
        }
        if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30_000) {
            throw new TxKeyError('AWS KMS timeout is invalid', 'invalid');
        }
        if (!allowedIds.length || allowedIds.length > 32
            || allowedIds.some((id) => !id.trim() || id.length > 2048)) {
            throw new TxKeyError('AWS KMS key allowlist is invalid', 'invalid');
        }
        this.client = client ?? new KMSClient(config);
        this.allowedIds = [...new Set([keyId, ...allowedIds])];
    }

    async generate(context: KeyContext): Promise<TxDataKey> {
        try {
            const signal = AbortSignal.timeout(this.timeoutMs);
            const trust = await this.keyTrust(signal);
            const output = await this.client.send(new GenerateDataKeyCommand({
                KeyId: trust.current,
                KeySpec: 'AES_256',
                EncryptionContext: context,
            }), { abortSignal: signal });
            const plaintext = copyKey(output.Plaintext);
            const wrapped = output.CiphertextBlob && Buffer.from(output.CiphertextBlob);
            if (!plaintext || plaintext.length !== 32 || !wrapped?.length
                || output.KeyId !== trust.current || !trust.allowed.has(output.KeyId)) {
                plaintext?.fill(0);
                throw new TxKeyError('AWS KMS returned an incomplete AES-256 data key', 'invalid');
            }
            if (wrapped.length > 8192 || output.KeyId.length > 2048) {
                plaintext.fill(0);
                throw new TxKeyError('AWS KMS data key exceeds the storage contract', 'invalid');
            }
            return { plaintext, wrapped, keyId: output.KeyId };
        } catch (error) {
            if (error instanceof TxKeyError) throw error;
            throw new TxKeyError(
                'AWS KMS could not generate a transaction data key', keyFailure(error), error
            );
        }
    }

    async unwrap(wrapped: Buffer, keyId: string, context: KeyContext): Promise<Buffer> {
        if (!wrapped.length || wrapped.length > 8192 || !keyId || keyId.length > 2048) {
            throw new TxKeyError('Wrapped transaction key metadata is invalid', 'invalid');
        }
        try {
            const signal = AbortSignal.timeout(this.timeoutMs);
            const trust = await this.keyTrust(signal);
            if (!trust.allowed.has(keyId)) {
                throw new TxKeyError(
                    'Stored transaction key is outside the configured allowlist', 'invalid'
                );
            }
            const output = await this.client.send(new DecryptCommand({
                CiphertextBlob: wrapped,
                EncryptionContext: context,
                KeyId: keyId,
            }), { abortSignal: signal });
            const plaintext = copyKey(output.Plaintext);
            if (!plaintext || plaintext.length !== 32 || output.KeyId !== keyId) {
                plaintext?.fill(0);
                throw new TxKeyError('AWS KMS returned the wrong transaction data key', 'invalid');
            }
            return plaintext;
        } catch (error) {
            if (error instanceof TxKeyError) throw error;
            throw new TxKeyError(
                'AWS KMS could not unwrap the transaction data key', keyFailure(error), error
            );
        }
    }

    private keyTrust(signal: AbortSignal): Promise<{
        current: string;
        allowed: ReadonlySet<string>;
    }> {
        if (!this.trust) {
            const pending = (async () => {
                const resolved = await Promise.all(
                    this.allowedIds.map((id) => this.resolve(id, signal))
                );
                const current = resolved[0];
                const allowed = new Set(resolved);
                if (!allowed.has(current)) {
                    throw new TxKeyError(
                        'Current AWS KMS key is outside the configured allowlist', 'invalid'
                    );
                }
                return { current, allowed };
            })();
            this.trust = pending;
            void pending.catch(() => {
                if (this.trust === pending) this.trust = undefined;
            });
        }
        return this.trust;
    }

    private async resolve(keyId: string, signal: AbortSignal): Promise<string> {
        if (/^arn:(?:aws|aws-us-gov|aws-cn):kms:[^:]+:[0-9]{12}:key\/[A-Za-z0-9-]+$/.test(keyId)) {
            return keyId;
        }
        try {
            const output = await this.client.send(new DescribeKeyCommand({ KeyId: keyId }), {
                abortSignal: signal,
            });
            const arn = output.KeyMetadata?.Arn;
            if (!arn || !/^arn:(?:aws|aws-us-gov|aws-cn):kms:[^:]+:[0-9]{12}:key\/[A-Za-z0-9-]+$/.test(arn)) {
                throw new TxKeyError('AWS KMS did not resolve a canonical key ARN', 'invalid');
            }
            return arn;
        } catch (error) {
            if (error instanceof TxKeyError) throw error;
            throw new TxKeyError(
                'AWS KMS key identity could not be resolved', keyFailure(error), error
            );
        }
    }
}

export const createTxKeyProvider = (): TxKeyProvider => {
    if (env.TX_KEY_PROVIDER !== 'aws_kms' || !env.TX_KMS_KEY_ID) {
        throw new TxKeyError('Signed transaction key management is not configured', 'invalid');
    }
    const retired = (env.TX_KMS_KEY_ALLOWLIST || '')
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean);
    return new AwsTxKeyProvider(
        env.TX_KMS_KEY_ID,
        undefined,
        {},
        env.TX_KMS_TIMEOUT_MS,
        [env.TX_KMS_KEY_ID, ...retired]
    );
};
