import http, { Server } from 'http';
import { metrics } from './metrics';

export class WorkerProbe {
    private server?: Server;
    private passed = false;
    private failures = 0;
    private stopping = false;
    private lastSuccess = 0;
    private readonly metric: string;

    constructor(
        private readonly name: string,
        private readonly port: number,
        private readonly maxErrors: number,
        private readonly maxAgeMs: number
    ) {
        if (!/^[a-z][a-z0-9_]*$/.test(name)) {
            throw new Error('Worker probe name must be a Prometheus-safe identifier');
        }
        this.metric = `fervor_${name}`;
    }

    async start(): Promise<number> {
        if (this.server) throw new Error('Worker probe is already running');
        const server = http.createServer((req, res) => {
            if (req.url === '/metrics') {
                this.refresh();
                res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' });
                res.end(metrics.toPrometheus());
                return;
            }
            if (req.url === '/health') {
                const healthy = this.isHealthy();
                res.writeHead(healthy ? 200 : 503, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ healthy, worker: this.name }));
                return;
            }
            res.writeHead(404).end();
        });
        this.server = server;
        await new Promise<void>((resolve, reject) => {
            const failed = (error: Error): void => reject(error);
            server.once('error', failed);
            server.listen(this.port, '0.0.0.0', () => {
                server.removeListener('error', failed);
                resolve();
            });
        });
        const address = server.address();
        if (!address || typeof address === 'string') {
            throw new Error('Worker probe has no TCP address');
        }
        return address.port;
    }

    success(): void {
        this.passed = true;
        this.failures = 0;
        this.lastSuccess = Date.now();
        metrics.gauge(`${this.metric}_healthy`, 1);
        metrics.gauge(`${this.metric}_failures`, 0);
        metrics.gauge(`${this.metric}_last_success_unixtime`, Math.floor(Date.now() / 1000));
    }

    failure(): boolean {
        this.failures += 1;
        metrics.gauge(`${this.metric}_healthy`, 0);
        metrics.gauge(`${this.metric}_failures`, this.failures);
        return this.failures >= this.maxErrors;
    }

    async stop(): Promise<void> {
        this.stopping = true;
        metrics.gauge(`${this.metric}_healthy`, 0);
        const server = this.server;
        this.server = undefined;
        if (!server) return;
        await new Promise<void>((resolve, reject) => {
            server.close((error) => error ? reject(error) : resolve());
        });
    }

    private isHealthy(): boolean {
        return this.passed && this.failures === 0 && !this.stopping
            && Date.now() - this.lastSuccess <= this.maxAgeMs;
    }

    private refresh(): void {
        metrics.gauge(`${this.metric}_healthy`, this.isHealthy() ? 1 : 0);
    }
}
