import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { flywayImage } from './migration-config.mjs';

const passEnv = [
    'DOCKER_CONFIG',
    'DOCKER_CONTEXT',
    'DOCKER_HOST',
    'HOME',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'NO_PROXY',
    'PATH',
    'TERM',
];

class FlywayRunError extends Error {
    constructor(message, result) {
        super(message);
        this.name = 'FlywayRunError';
        this.stdout = result?.stdout ?? '';
        this.stderr = result?.stderr ?? '';
        this.code = result?.code;
        this.signal = result?.signal;
        this.timedOut = result?.timedOut ?? false;
    }
}

const timeLeft = (deadline) => deadline - Date.now();

const cleanupReserve = (deadline) => Math.min(30_000, Math.max(100, Math.floor(timeLeft(deadline) / 5)));

const procWindow = (deadline, { parts = 1, reserveMs = 0, maxMs = Infinity, graceMs = 5_000 } = {}) => {
    const available = timeLeft(deadline) - reserveMs;
    if (available < 2) throw new Error('Flyway wall-clock deadline expired before the next subprocess');
    const total = Math.min(maxMs, Math.max(1, Math.floor(available / parts)));
    const grace = Math.min(graceMs, Math.max(0, Math.floor(total / 4)));
    return { timeoutMs: Math.max(1, total - grace), graceMs: grace };
};

export const cleanEnv = (extra = {}, source = process.env) => {
    const env = {};
    for (const key of passEnv) {
        if (source[key] !== undefined) env[key] = source[key];
    }
    return { ...env, ...extra };
};

export const runProc = (command, args, options = {}) => new Promise((resolve, reject) => {
    const timeoutMs = options.timeoutMs ?? 60_000;
    const graceMs = options.graceMs ?? 5_000;
    const capture = options.capture ?? false;
    const streamAfterMs = options.streamAfterMs;
    const child = spawn(command, args, {
        cwd: options.cwd,
        env: options.env ?? cleanEnv(),
        stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let killTimer;
    let streamTimer;
    let settled = false;
    let streamed = false;
    let pendingOut = '';
    let pendingErr = '';
    if (capture) {
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', (chunk) => {
            stdout += chunk;
            if (streamed) process.stdout.write(chunk);
            else pendingOut += chunk;
        });
        child.stderr.on('data', (chunk) => {
            stderr += chunk;
            if (streamed) process.stderr.write(chunk);
            else pendingErr += chunk;
        });
        if (streamAfterMs !== undefined) {
            streamTimer = setTimeout(() => {
                streamed = true;
                if (pendingOut) process.stdout.write(pendingOut);
                if (pendingErr) process.stderr.write(pendingErr);
                pendingOut = '';
                pendingErr = '';
            }, streamAfterMs);
            streamTimer.unref();
        }
    }
    const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        killTimer = setTimeout(() => child.kill('SIGKILL'), graceMs);
        killTimer.unref();
    }, timeoutMs);
    timer.unref();
    child.once('error', (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(killTimer);
        clearTimeout(streamTimer);
        reject(error);
    });
    child.once('close', (code, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(killTimer);
        clearTimeout(streamTimer);
        resolve({ code, signal, timedOut, stdout, stderr, streamed });
    });
});

const docker = async (args, options = {}) => {
    const result = await runProc('docker', args, {
        ...options,
        env: options.env ?? cleanEnv(),
    });
    if (result.timedOut) throw new Error(`docker ${args[0]} exceeded ${options.timeoutMs ?? 60_000} ms`);
    if (result.code !== 0) {
        const detail = result.stderr.trim();
        throw new Error(`docker ${args[0]} failed with ${result.signal ?? result.code}${detail ? `: ${detail}` : ''}`);
    }
    return result;
};

const missingContainer = (error) => error instanceof Error && error.message.includes('No such container');

const remove = async (name, env, deadline) => {
    const failures = [];
    try {
        const window = procWindow(deadline, { parts: 2, graceMs: 1_000 });
        await docker(['stop', '--time', '10', name], { ...window, capture: true, env });
    } catch (error) {
        if (!missingContainer(error)) failures.push(error);
    }
    try {
        const window = procWindow(deadline, { graceMs: 1_000 });
        await docker(['rm', '--force', name], { ...window, capture: true, env });
    } catch (error) {
        if (!missingContainer(error)) failures.push(error);
    }
    if (failures.length > 0) throw new AggregateError(failures, `Failed to clean Flyway container ${name}`);
};

const runOnce = async ({
    root, plane, target, command, deadline, extra = [], stream = false, configFiles,
}) => {
    const name = `fervor-flyway-${plane}-${process.pid}-${randomBytes(4).toString('hex')}`;
    const dockerEnv = cleanEnv();
    const secretDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fervor-flyway-'));
    const secretFile = path.join(secretDir, 'db-password');
    try {
        fs.writeFileSync(secretFile, target.password, { mode: 0o600 });
    } catch (error) {
        fs.rmSync(secretDir, { recursive: true, force: true });
        throw error;
    }
    const createEnv = cleanEnv({
        FLYWAY_URL: target.url,
        FLYWAY_USER: target.user,
    });
    const args = [
        'create',
        '--name',
        name,
        '--add-host=host.docker.internal:host-gateway',
        '--mount',
        `type=bind,src=${path.join(root, 'db')},dst=/flyway/db,readonly`,
        '--mount',
        `type=bind,src=${secretFile},dst=/run/secrets/db-password,readonly`,
        '-e',
        'FLYWAY_URL',
        '-e',
        'FLYWAY_USER',
    ];
    if (target.caFile) {
        args.push('--mount', `type=bind,src=${path.resolve(target.caFile)},dst=/flyway/certs/db-ca.pem,readonly`);
    }
    args.push(
        '--entrypoint',
        '/bin/sh',
        flywayImage,
        '-ec',
        'export FLYWAY_PASSWORD="$(cat /run/secrets/db-password)"; exec /flyway/flyway "$@"',
        'flyway-runner',
        `-configFiles=${configFiles ?? `/flyway/db/flyway/${plane}.conf`}`,
        ...extra,
    );
    if (command === 'validate') args.push('-ignoreMigrationPatterns=*:pending');
    args.push(command);

    let failure;
    let result;
    try {
        const createWindow = procWindow(deadline, {
            reserveMs: cleanupReserve(deadline),
            maxMs: 60_000,
            graceMs: 2_000,
        });
        await docker(args, { ...createWindow, capture: true, env: createEnv });
        const runWindow = procWindow(deadline, {
            reserveMs: cleanupReserve(deadline),
            graceMs: 10_000,
        });
        result = await runProc('docker', ['start', '--attach', name], {
            ...runWindow,
            env: dockerEnv,
            capture: true,
            streamAfterMs: stream ? 5_000 : undefined,
        });
        if (result.timedOut) {
            throw new FlywayRunError(`Flyway ${command} exceeded its wall-clock deadline for ${plane}`, result);
        }
        if (result.code !== 0) {
            const detail = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
            const suffix = !result.streamed && detail ? `:\n${detail}` : '';
            throw new FlywayRunError(
                `Flyway ${command} failed for ${plane} with ${result.signal ?? result.code}${suffix}`,
                result,
            );
        }
    } catch (error) {
        failure = error;
    }

    const cleanup = [];
    try {
        await remove(name, dockerEnv, deadline);
    } catch (error) {
        cleanup.push(error);
    }
    try {
        fs.rmSync(secretDir, { recursive: true, force: true });
    } catch (error) {
        cleanup.push(error);
    }

    if (failure && cleanup.length > 0) {
        throw new AggregateError([failure, ...cleanup], `Flyway ${command} failed and cleanup was incomplete`);
    }
    if (failure) throw failure;
    if (cleanup.length > 0) throw new AggregateError(cleanup, `Flyway ${command} cleanup was incomplete`);
    return result;
};

const lockConflict = (error) => error instanceof FlywayRunError
    && !(error instanceof AggregateError)
    && [error.message, error.stdout, error.stderr]
        .some((value) => value.includes('fervor migration lock unavailable'));

export const runFlyway = async (options) => {
    const { plane, command, timeoutMs, capture = false } = options;
    const deadline = Date.now() + timeoutMs;
    let attempt = 0;
    let lastError;
    while (Date.now() < deadline) {
        const remaining = deadline - Date.now();
        if (remaining < 1_000) break;
        try {
            const result = await runOnce({ ...options, deadline, stream: !capture });
            if (!capture && !result.streamed) {
                if (result.stdout) process.stdout.write(result.stdout);
                if (result.stderr) process.stderr.write(result.stderr);
            }
            return result;
        } catch (error) {
            if (!lockConflict(error)) throw error;
            lastError = error;
            attempt += 1;
            if (!capture && (attempt === 1 || attempt % 10 === 0)) {
                process.stderr.write(`Flyway ${command} is waiting for the ${plane} migration lock (attempt ${attempt})\n`);
            }
            const backoff = Math.min(1_000, 50 * (2 ** Math.min(attempt - 1, 4)));
            const jitter = randomBytes(2).readUInt16BE(0) % 51;
            const waitMs = Math.min(backoff + jitter, deadline - Date.now());
            if (waitMs > 0) await delay(waitMs);
        }
    }
    throw new Error(`Flyway ${command} could not acquire the ${plane} migration lock within ${timeoutMs} ms`, {
        cause: lastError,
    });
};

export const pullFlyway = async () => {
    await docker(['pull', flywayImage], { timeoutMs: 300_000, env: cleanEnv() });
};
