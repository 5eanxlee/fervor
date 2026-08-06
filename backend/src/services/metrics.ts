type LabelSet = Record<string, string | number | boolean | undefined>;

interface MetricPoint {
    name: string;
    labels?: LabelSet;
    value: number;
}

interface ObservationPoint extends MetricPoint {
    cursor: number;
    samples: number[];
}

const MAX_SAMPLES = 1000;

const labelKey = (labels?: LabelSet): string => {
    if (!labels) return '';
    return Object.entries(labels)
        .filter(([, value]) => value !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, value]) => JSON.stringify([key, String(value)]))
        .join(',');
};

const prometheusLabels = (labels?: LabelSet): string => {
    if (!labels) return '';
    const entries = Object.entries(labels).filter(([, value]) => value !== undefined);
    if (entries.length === 0) return '';
    const escape = (value: unknown) => String(value)
        .replace(/\\/g, '\\\\')
        .replace(/\n/g, '\\n')
        .replace(/"/g, '\\"');
    return `{${entries.map(([key, value]) => `${key}="${escape(value)}"`).join(',')}}`;
};

class MetricsRegistry {
    private counters = new Map<string, MetricPoint>();
    private gauges = new Map<string, MetricPoint>();
    private observations = new Map<string, ObservationPoint>();

    increment(name: string, labels?: LabelSet, amount = 1): void {
        const key = `${name}:${labelKey(labels)}`;
        const existing = this.counters.get(key);
        this.counters.set(key, {
            name,
            labels,
            value: (existing?.value || 0) + amount,
        });
    }

    gauge(name: string, value: number, labels?: LabelSet): void {
        const key = `${name}:${labelKey(labels)}`;
        this.gauges.set(key, { name, labels, value });
    }

    observe(name: string, value: number, labels?: LabelSet): void {
        const key = `${name}:${labelKey(labels)}`;
        const point = this.observations.get(key) ?? {
            name,
            labels,
            value: 0,
            cursor: 0,
            samples: [],
        };
        point.value += 1;
        if (point.samples.length < MAX_SAMPLES) {
            point.samples.push(value);
        } else {
            point.samples[point.cursor] = value;
            point.cursor = (point.cursor + 1) % MAX_SAMPLES;
        }
        this.observations.set(key, point);
        this.gauge(`${name}_last`, value, labels);
    }

    timer(name: string, labels?: LabelSet): () => void {
        const started = process.hrtime.bigint();
        return () => {
            const elapsedMs = Number(process.hrtime.bigint() - started) / 1_000_000;
            this.observe(name, elapsedMs, labels);
        };
    }

    toPrometheus(): string {
        const lines: string[] = [
            '# HELP fervor_metric In-process Fervor backend metrics.',
            '# TYPE fervor_metric untyped',
        ];

        for (const point of this.counters.values()) {
            lines.push(`${point.name}_total${prometheusLabels(point.labels)} ${point.value}`);
        }

        for (const point of this.gauges.values()) {
            lines.push(`${point.name}${prometheusLabels(point.labels)} ${point.value}`);
        }

        for (const point of this.observations.values()) {
            if (point.samples.length === 0) continue;
            const sorted = [...point.samples].sort((a, b) => a - b);
            const p50Index = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.50));
            const p95Index = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95));
            const p99Index = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.99));
            const p999Index = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.999));
            const labels = prometheusLabels(point.labels);
            lines.push(`${point.name}_count${labels} ${point.value}`);
            lines.push(`${point.name}_p50${labels} ${sorted[p50Index]}`);
            lines.push(`${point.name}_p95${labels} ${sorted[p95Index]}`);
            lines.push(`${point.name}_p99${labels} ${sorted[p99Index]}`);
            lines.push(`${point.name}_p999${labels} ${sorted[p999Index]}`);
        }

        return `${lines.join('\n')}\n`;
    }
}

export const metrics = new MetricsRegistry();
