import { DecryptCommand, DescribeKeyCommand, GenerateDataKeyCommand } from '@aws-sdk/client-kms';
import { describe, expect, it, vi } from 'vitest';
import { AwsTxKeyProvider } from '../src/services/orders/txKeyProvider';

describe('AWS transaction key provider', () => {
    it('uses AES-256 and an exact encryption context, then erases SDK plaintext', async () => {
        const source = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
        const send = vi.fn(async (
            command: GenerateDataKeyCommand | DecryptCommand,
            _options?: { abortSignal?: AbortSignal }
        ) => {
            if (command instanceof GenerateDataKeyCommand) {
                expect(command.input).toEqual({
                    KeyId: 'arn:aws:kms:us-west-2:123456789012:key/test',
                    KeySpec: 'AES_256',
                    EncryptionContext: { actionId: 'action', aadHash: 'hash' },
                });
                return {
                    Plaintext: source,
                    CiphertextBlob: Uint8Array.from([9, 8, 7]),
                    KeyId: 'arn:aws:kms:us-west-2:123456789012:key/test',
                };
            }
            throw new Error('unexpected command');
        });
        const provider = new AwsTxKeyProvider(
            'arn:aws:kms:us-west-2:123456789012:key/test',
            { send } as never
        );

        const key = await provider.generate({ actionId: 'action', aadHash: 'hash' });
        expect(key.plaintext).toEqual(Buffer.from(Array.from({ length: 32 }, (_, index) => index + 1)));
        expect(key.wrapped).toEqual(Buffer.from([9, 8, 7]));
        expect(source.every((byte) => byte === 0)).toBe(true);
        expect(send.mock.calls[0][1]?.abortSignal).toBeInstanceOf(AbortSignal);
    });

    it('binds unwrap to both the stored key identity and encryption context', async () => {
        const source = new Uint8Array(32).fill(5);
        const send = vi.fn(async (
            command: GenerateDataKeyCommand | DecryptCommand,
            _options?: { abortSignal?: AbortSignal }
        ) => {
            expect(command).toBeInstanceOf(DecryptCommand);
            expect((command as DecryptCommand).input).toMatchObject({
                KeyId: 'arn:aws:kms:us-west-2:123456789012:key/test',
                EncryptionContext: { actionId: 'action', aadHash: 'hash' },
            });
            return {
                Plaintext: source,
                KeyId: 'arn:aws:kms:us-west-2:123456789012:key/test',
            };
        });
        const provider = new AwsTxKeyProvider(
            'arn:aws:kms:us-west-2:123456789012:key/test',
            { send } as never
        );

        const key = await provider.unwrap(
            Buffer.from([1, 2, 3]),
            'arn:aws:kms:us-west-2:123456789012:key/test',
            { actionId: 'action', aadHash: 'hash' }
        );
        expect(key).toEqual(Buffer.alloc(32, 5));
        expect(source.every((byte) => byte === 0)).toBe(true);
    });

    it('fails closed on incomplete or mismatched KMS output', async () => {
        const provider = new AwsTxKeyProvider('arn:aws:kms:us-west-2:123456789012:key/test', {
            send: vi.fn().mockResolvedValue({
                Plaintext: new Uint8Array(32),
                KeyId: 'arn:aws:kms:us-west-2:123456789012:key/other',
            }),
        } as never);
        await expect(provider.generate({ actionId: 'a' })).rejects.toThrow(/incomplete/);
        await expect(provider.unwrap(
            Buffer.from([1]), 'arn:aws:kms:us-west-2:123456789012:key/test', { actionId: 'a' }
        )).rejects.toThrow(/wrong/);
    });

    it('classifies provider outages separately from invalid stored ciphertext', async () => {
        const keyId = 'arn:aws:kms:us-west-2:123456789012:key/test';
        const transient = Object.assign(new Error('throttled'), {
            name: 'ThrottlingException',
            $retryable: { throttling: true },
        });
        const unavailable = new AwsTxKeyProvider(keyId, {
            send: vi.fn().mockRejectedValue(transient),
        } as never);
        await expect(unavailable.unwrap(Buffer.from([1]), keyId, { actionId: 'a' }))
            .rejects.toMatchObject({ kind: 'unavailable' });

        const invalid = Object.assign(new Error('invalid ciphertext'), {
            name: 'InvalidCiphertextException',
            $metadata: { httpStatusCode: 400 },
        });
        const rejected = new AwsTxKeyProvider(keyId, {
            send: vi.fn().mockRejectedValue(invalid),
        } as never);
        await expect(rejected.unwrap(Buffer.from([1]), keyId, { actionId: 'a' }))
            .rejects.toMatchObject({ kind: 'invalid' });
    });

    it('bounds alias resolution and decrypt with one unwrap deadline', async () => {
        const alias = 'alias/fervor-order-transactions';
        const arn = 'arn:aws:kms:us-west-2:123456789012:key/resolved';
        const signals: AbortSignal[] = [];
        const pause = (signal: AbortSignal) => new Promise<void>((resolve, reject) => {
            const abort = () => {
                clearTimeout(timer);
                reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
            };
            const timer = setTimeout(() => {
                signal.removeEventListener('abort', abort);
                resolve();
            }, 60);
            if (signal.aborted) abort();
            else signal.addEventListener('abort', abort, { once: true });
        });
        const send = vi.fn(async (
            command: DescribeKeyCommand | DecryptCommand,
            options?: { abortSignal?: AbortSignal }
        ) => {
            const signal = options?.abortSignal;
            if (!signal) throw new Error('missing abort signal');
            signals.push(signal);
            await pause(signal);
            if (command instanceof DescribeKeyCommand) {
                return { KeyMetadata: { Arn: arn, KeyId: 'resolved' } };
            }
            return { Plaintext: new Uint8Array(32), KeyId: arn };
        });
        const provider = new AwsTxKeyProvider(alias, { send } as never, {}, 100);

        await expect(provider.unwrap(Buffer.from([1]), arn, { actionId: 'a' }))
            .rejects.toMatchObject({ kind: 'unavailable' });
        expect(signals).toHaveLength(2);
        expect(signals[1]).toBe(signals[0]);
    });

    it('resolves aliases once and persists the canonical current-key ARN', async () => {
        const arn = 'arn:aws:kms:us-west-2:123456789012:key/resolved';
        const send = vi.fn(async (command: DescribeKeyCommand | GenerateDataKeyCommand) => {
            if (command instanceof DescribeKeyCommand) {
                expect(command.input.KeyId).toBe('alias/fervor-order-transactions');
                return { KeyMetadata: { Arn: arn, KeyId: 'resolved' } };
            }
            expect(command.input.KeyId).toBe(arn);
            return {
                Plaintext: new Uint8Array(32).fill(7),
                CiphertextBlob: new Uint8Array([1, 2, 3]),
                KeyId: arn,
            };
        });
        const provider = new AwsTxKeyProvider(
            'alias/fervor-order-transactions', { send } as never
        );

        await expect(provider.generate({ actionId: 'a' })).resolves.toMatchObject({ keyId: arn });
        expect(send).toHaveBeenCalledTimes(2);
    });

    it('retries canonical key resolution after a transient failure', async () => {
        const arn = 'arn:aws:kms:us-west-2:123456789012:key/retry';
        let describes = 0;
        const send = vi.fn(async (command: DescribeKeyCommand | GenerateDataKeyCommand) => {
            if (command instanceof DescribeKeyCommand) {
                describes += 1;
                if (describes === 1) throw new Error('transient KMS failure');
                return { KeyMetadata: { Arn: arn, KeyId: 'retry' } };
            }
            return {
                Plaintext: new Uint8Array(32).fill(7),
                CiphertextBlob: new Uint8Array([1, 2, 3]),
                KeyId: arn,
            };
        });
        const provider = new AwsTxKeyProvider('alias/fervor-order-transactions', { send } as never);

        await expect(provider.generate({ actionId: 'a' })).rejects.toThrow(/could not be resolved/);
        await expect(provider.generate({ actionId: 'a' })).resolves.toMatchObject({ keyId: arn });
        expect(describes).toBe(2);
    });

    it('rejects a database-selected key outside the configured current and retired set', async () => {
        const current = 'arn:aws:kms:us-west-2:123456789012:key/current';
        const forged = 'arn:aws:kms:us-west-2:123456789012:key/forged';
        const send = vi.fn();
        const provider = new AwsTxKeyProvider(current, { send } as never);

        await expect(provider.unwrap(
            Buffer.from([1]), forged, { actionId: 'a' }
        )).rejects.toThrow(/outside the configured allowlist/);
        expect(send).not.toHaveBeenCalled();
    });
});
