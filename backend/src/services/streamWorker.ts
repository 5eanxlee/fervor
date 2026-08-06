import { StreamMessage } from './redisStreamService';

export const uniqueStreamMessages = <T>(messages: StreamMessage<T>[]): StreamMessage<T>[] =>
    Array.from(new Map(messages.map((message) => [message.id, message])).values());

export const mapConcurrent = async <T>(
    values: T[],
    limit: number,
    worker: (value: T) => Promise<void>
): Promise<void> => {
    let cursor = 0;
    const count = Math.min(Math.max(1, limit), values.length);
    await Promise.all(Array.from({ length: count }, async () => {
        while (cursor < values.length) {
            const index = cursor;
            cursor += 1;
            await worker(values[index]);
        }
    }));
};
