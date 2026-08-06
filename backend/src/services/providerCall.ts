interface BoundSignal {
    signal: AbortSignal;
    close: () => void;
}

export const boundedSignal = (timeoutMs: number, external?: AbortSignal): BoundSignal => {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
        controller.abort(Object.assign(new Error('Provider call timed out'), {
            name: 'TimeoutError',
        }));
    }, timeoutMs);
    timeout.unref?.();

    const abort = (): void => controller.abort(external?.reason);
    let listening = false;
    let closed = false;
    if (external?.aborted) abort();
    else if (external) {
        external.addEventListener('abort', abort, { once: true });
        listening = true;
    }

    return {
        signal: controller.signal,
        close: () => {
            if (closed) return;
            closed = true;
            clearTimeout(timeout);
            if (listening) {
                external?.removeEventListener('abort', abort);
                listening = false;
            }
        },
    };
};

export const abortable = <T>(
    work: Promise<T>,
    signal: AbortSignal,
    error: () => Error
): Promise<T> => new Promise<T>((resolve, reject) => {
    const aborted = (): void => reject(error());
    if (signal.aborted) {
        void work.catch(() => undefined);
        aborted();
        return;
    }
    signal.addEventListener('abort', aborted, { once: true });
    work.then(
        (value) => {
            signal.removeEventListener('abort', aborted);
            resolve(value);
        },
        (reason) => {
            signal.removeEventListener('abort', aborted);
            reject(reason);
        }
    );
});
