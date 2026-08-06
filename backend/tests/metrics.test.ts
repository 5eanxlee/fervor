import { describe, expect, it } from 'vitest';
import { metrics } from '../src/services/metrics';

describe('metrics registry', () => {
    it('preserves observation labels as separate Prometheus series', () => {
        const name = 'fervor_test_plane_latency_ms';
        metrics.observe(name, 2, { plane: 'core' });
        metrics.observe(name, 7, { plane: 'market' });

        const output = metrics.toPrometheus();
        expect(output).toContain(`${name}_count{plane="core"} 1`);
        expect(output).toContain(`${name}_p50{plane="core"} 2`);
        expect(output).toContain(`${name}_count{plane="market"} 1`);
        expect(output).toContain(`${name}_p50{plane="market"} 7`);
    });

    it('keeps a bounded rolling sample while retaining the total count', () => {
        const name = 'fervor_test_ring_latency_ms';
        for (let value = 0; value < 1005; value += 1) metrics.observe(name, value);

        const output = metrics.toPrometheus();
        expect(output).toContain(`${name}_count 1005`);
        expect(output).toContain(`${name}_p999 1004`);
        expect(output).not.toContain(`${name}_p50 4\n`);
    });
});
