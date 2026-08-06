import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import {
    clone,
    compileSchema,
    parse,
    read,
    resolveRoot,
} from './spec-utils.mjs';

const schemaPath = resolveRoot('tests', 'contracts', 'slo-contracts.schema.json');
const targetsPath = resolveRoot('tests', 'contracts', 'slo-targets.json');
const casesPath = resolveRoot('tests', 'contracts', 'slo-fixtures.json');
const regionsPath = resolveRoot('tests', 'contracts', 'regions.json');

const schema = parse(schemaPath);
const targets = parse(targetsPath);
const cases = parse(casesPath);
const regions = parse(regionsPath);
const targetSchema = compileSchema(schema);
const caseSchema = compileSchema({
    $schema: schema.$schema,
    definitions: schema.definitions,
    $ref: '#/definitions/caseSet',
});

const regionErrors = [];
if (JSON.stringify(Object.keys(regions)) !== JSON.stringify(['schema', 'regions']) || regions.schema !== 1) {
    regionErrors.push('region registry shape changed');
}
if (!Array.isArray(regions.regions) || regions.regions.length === 0
    || new Set(regions.regions).size !== regions.regions.length
    || regions.regions.some((item) => !/^[a-z][a-z0-9]*(?:_[a-z0-9]+){0,2}$/.test(item))) {
    regionErrors.push('region registry contains invalid or duplicate IDs');
}
if (regionErrors.length > 0) throw new Error(regionErrors.join('\n'));

const expected = {
    objectives: [
        'api_good',
        'core_accept',
        'action_resolve',
        'order_accept',
        'reconcile_start',
        'quote_overhead',
        'swap_dispatch',
        'swap_accept',
        'swap_settle',
        'order_fresh',
        'chain_reflect',
        'exec_fresh',
        'market_fresh',
        'market_project',
        'metric_apply',
        'alert_match',
        'alert_lookup',
        'alert_eval',
        'notify_accept',
        'wallet_project',
        'wallet_fresh',
        'stream_delivery',
        'stream_write',
    ],
    journeys: [
        'api_good',
        'core_accept',
        'order_accept',
        'swap_accept',
        'swap_settle',
        'order_fresh',
        'exec_fresh',
        'market_fresh',
        'alert_match',
        'notify_accept',
        'wallet_fresh',
        'stream_delivery',
    ],
    gates: [
        'duplicate_effect',
        'lost_intent',
        'invalid_tx',
        'excess_fill',
        'ledger_gap',
        'funds_gap',
        'silent_gap',
        'stale_epoch',
        'secret_leak',
        'action_overdue',
        'unbounded_state',
        'telemetry_gap',
    ],
    recovery: ['core_az', 'core_region_read', 'core_region_write', 'market_restore', 'redis_rebuild'],
    safety: ['epoch_resume'],
    profiles: ['orders', 'ingest', 'alerts', 'notify', 'wallet', 'gateway', 'browser', 'recovery'],
    reports: [
        'commit',
        'image',
        'fixtures',
        'hardware',
        'topology',
        'config',
        'duration',
        'samples',
        'quantiles',
        'resources',
        'loss',
        'recovery',
        'telemetry',
        'artifacts',
        'baseline',
    ],
    domains: {
        api_admit: ['admitted', 'edge_overload', 'edge_timeout', 'bad_syntax', 'bad_route', 'no_auth', 'no_right', 'over_quota', 'body_too_large', 'client_disconnect', 'synthetic', 'load_test', 'operator_smoke'],
        intent_admit: ['validated', 'invalid_input', 'expired_at_entry', 'unsupported_version', 'synthetic', 'load_test'],
        action_admit: ['durable', 'expired', 'unsupported', 'synthetic', 'load_test'],
        event_admit: ['supported', 'unsupported', 'synthetic', 'load_test'],
        minute_admit: ['active', 'inactive', 'synthetic'],
        notify_admit: ['within_capacity', 'above_contract', 'disabled_before_match', 'synthetic', 'load_test'],
        stream_admit: ['subscribed', 'unsubscribed', 'precommit_drop', 'synthetic', 'load_test'],
        order_op: ['activate', 'edit', 'cancel', 'withdraw'],
        notify_channel: ['telegram', 'discord'],
        api_result: ['success', 'reject_invalid', 'reject_conflict', 'reject_not_found', 'reject_expired', 'reject_unsupported', 'reject_auth', 'reject_forbidden', 'reject_quota', 'reject_too_large', 'reject_risk', 'reject_balance', 'reject_tx_guard', 'noop_terminal', 'idem_replay', 'overload', 'dependency_fail', 'timeout', 'disconnect', 'post_admit_cancel', 'service_error', 'invalid_success', 'unknown'],
        commit_result: ['committed', 'idem_replay', 'reject', 'expired_in_service', 'unsupported_runtime', 'post_admit_cancel', 'partial', 'timeout', 'service_error', 'unknown'],
        resolve_result: ['present', 'absent', 'manual_review', 'conflict', 'timeout', 'unknown'],
        accept_result: ['accepted', 'landed', 'permanent_reject', 'possible', 'timeout', 'service_error', 'unknown'],
        stage_result: ['completed', 'failed', 'timeout', 'dropped', 'unknown'],
        match_result: ['matched', 'no_match', 'failed', 'timeout', 'dropped', 'unknown'],
        fresh_result: ['fresh', 'stale', 'gap', 'unknown'],
        settle_result: ['exact_confirmed', 'exact_finalized', 'chain_failed', 'mismatch', 'timeout', 'gap', 'unknown'],
        notify_result: ['accepted', 'delivered', 'permanent_reject', 'possible', 'dead_letter', 'timeout', 'service_error', 'unknown'],
        stream_result: ['written', 'explicit_disconnect', 'backpressure_drop', 'silent_drop', 'timeout', 'unknown'],
    },
    eligibility: {
        api_eligible: [['admitted', 'edge_overload', 'edge_timeout', 'over_quota', 'client_disconnect'], ['bad_syntax', 'bad_route', 'no_auth', 'no_right', 'body_too_large', 'synthetic', 'load_test', 'operator_smoke']],
        intent_eligible: [['validated'], ['invalid_input', 'expired_at_entry', 'unsupported_version', 'synthetic', 'load_test']],
        action_eligible: [['durable'], ['expired', 'unsupported', 'synthetic', 'load_test']],
        event_eligible: [['supported'], ['unsupported', 'synthetic', 'load_test']],
        minute_eligible: [['active'], ['inactive', 'synthetic']],
        notify_eligible: [['within_capacity'], ['above_contract', 'disabled_before_match', 'synthetic', 'load_test']],
        stream_eligible: [['subscribed'], ['unsubscribed', 'precommit_drop', 'synthetic', 'load_test']],
    },
    results: {
        api_success: [['success', 'reject_invalid', 'reject_conflict', 'reject_not_found', 'reject_expired', 'reject_unsupported', 'reject_auth', 'reject_forbidden', 'reject_too_large', 'reject_risk', 'reject_balance', 'reject_tx_guard', 'noop_terminal', 'idem_replay'], ['reject_quota', 'overload', 'dependency_fail', 'timeout', 'disconnect', 'post_admit_cancel', 'service_error', 'invalid_success', 'unknown']],
        commit_success: [['committed', 'idem_replay'], ['reject', 'expired_in_service', 'unsupported_runtime', 'post_admit_cancel', 'partial', 'timeout', 'service_error', 'unknown']],
        resolve_success: [['present', 'absent'], ['manual_review', 'conflict', 'timeout', 'unknown']],
        accept_success: [['accepted', 'landed'], ['permanent_reject', 'possible', 'timeout', 'service_error', 'unknown']],
        stage_success: [['completed'], ['failed', 'timeout', 'dropped', 'unknown']],
        match_success: [['matched', 'no_match'], ['failed', 'timeout', 'dropped', 'unknown']],
        fresh_success: [['fresh'], ['stale', 'gap', 'unknown']],
        settle_success: [['exact_confirmed', 'exact_finalized'], ['chain_failed', 'mismatch', 'timeout', 'gap', 'unknown']],
        notify_success: [['accepted', 'delivered'], ['permanent_reject', 'possible', 'dead_letter', 'timeout', 'service_error', 'unknown']],
        stream_success: [['written'], ['explicit_disconnect', 'backpressure_drop', 'silent_drop', 'timeout', 'unknown']],
    },
    proofSpec: [
        ['api_route', [['route_id', 'route_resolved', 'route_registry', 'before_start', 300000]]],
        ['api_noop', [['route_id', 'route_resolved', 'route_registry', 'before_start', 300000], ['no_effect', 'effect_absent', 'action_ledger', 'after_result', 0]]],
        ['api_idem', [['route_id', 'route_resolved', 'route_registry', 'before_start', 300000], ['request_id', 'identity_match', 'idem_ledger', 'after_result', 0], ['result_match', 'result_match', 'idem_ledger', 'after_result', 0]]],
        ['edge_overload', [['edge_class', 'edge_overload', 'edge_proxy', 'before_start', 1000]]],
        ['edge_timeout', [['edge_class', 'edge_timeout', 'edge_proxy', 'before_start', 1000]]],
        ['syntax_reject', [['parser_code', 'syntax_invalid', 'edge_parser', 'before_start', 0]]],
        ['route_reject', [['route_lookup', 'route_missing', 'route_registry', 'before_start', 300000]]],
        ['auth_reject', [['auth_state', 'auth_missing', 'auth_gateway', 'before_start', 1000]]],
        ['right_reject', [['right_id', 'right_missing', 'policy_store', 'before_start', 60000]]],
        ['quota_reject', [['quota_snapshot', 'quota_exceeded', 'quota_ledger', 'before_start', 1000], ['quota_version', 'version_pinned', 'quota_ledger', 'before_start', 1000], ['tenant_hmac', 'tenant_bound', 'quota_ledger', 'before_start', 1000]]],
        ['body_reject', [['body_limit', 'body_over_limit', 'edge_proxy', 'before_start', 0]]],
        ['disconnect', [['disconnect_source', 'client_disconnect', 'edge_proxy', 'after_result', 0]]],
        ['traffic_synth', [['traffic_mark', 'synthetic', 'traffic_registry', 'before_start', 300000]]],
        ['traffic_load', [['traffic_mark', 'load_test', 'traffic_registry', 'before_start', 300000]]],
        ['traffic_smoke', [['traffic_mark', 'operator_smoke', 'traffic_registry', 'before_start', 300000]]],
    ],
    pairSpec: [
        ...['success', 'reject_invalid', 'reject_conflict', 'reject_not_found', 'reject_expired', 'reject_unsupported', 'reject_risk', 'reject_balance', 'reject_tx_guard'].map((outcome) => ['admitted', outcome, 'result', 'api_route']),
        ['admitted', 'noop_terminal', 'result', 'api_noop'],
        ['admitted', 'idem_replay', 'result', 'api_idem'],
        ...['overload', 'dependency_fail', 'timeout', 'disconnect', 'post_admit_cancel', 'service_error', 'invalid_success', 'unknown'].map((outcome) => ['admitted', outcome, 'result', 'api_route']),
        ['edge_overload', 'overload', 'bad', 'edge_overload'],
        ['edge_timeout', 'timeout', 'bad', 'edge_timeout'],
        ['bad_syntax', 'reject_invalid', 'result', 'syntax_reject'],
        ['bad_route', 'reject_not_found', 'result', 'route_reject'],
        ['no_auth', 'reject_auth', 'result', 'auth_reject'],
        ['no_right', 'reject_forbidden', 'result', 'right_reject'],
        ['over_quota', 'reject_quota', 'bad', 'quota_reject'],
        ['body_too_large', 'reject_too_large', 'result', 'body_reject'],
        ['client_disconnect', 'disconnect', 'bad', 'disconnect'],
        ['synthetic', 'success', 'result', 'traffic_synth'],
        ['load_test', 'success', 'result', 'traffic_load'],
        ['operator_smoke', 'success', 'result', 'traffic_smoke'],
    ],
    cohortSpec: [
        ['alert_match', 'alert_rule_registry', 'alert_matcher', 'event_snapshot', ['source_hmac', 'event_id', 'snapshot_version', 'rule_hmac'], ['snapshot_version', 'rule_count', 'eval_count', 'coverage_watermark', 'result', 'match_receipt'], 'counts_equal', 'event_all', 'match_receipt', 'alert_effect_store', 'unknown_bad', 60, 'objective_start', 'telemetry_gap'],
        ['order_fresh', 'order_active_registry', 'order_fresh_sampler', 'active_minute', ['object_hmac', 'minute_start'], ['registry_version', 'watermark_at', 'sample_at', 'result'], 'one_per_active', 'one_key', null, null, 'unknown_bad', 120, 'objective_start', 'telemetry_gap'],
        ['exec_fresh', 'execution_active_registry', 'exec_fresh_sampler', 'active_minute', ['object_hmac', 'minute_start'], ['registry_version', 'watermark_at', 'sample_at', 'result'], 'one_per_active', 'one_key', null, null, 'unknown_bad', 120, 'objective_start', 'telemetry_gap'],
        ['market_fresh', 'market_shard_registry', 'market_fresh_sampler', 'active_minute', ['object_hmac', 'minute_start'], ['registry_version', 'watermark_at', 'sample_at', 'result'], 'one_per_active', 'one_key', null, null, 'unknown_bad', 120, 'objective_start', 'telemetry_gap'],
        ['wallet_fresh', 'wallet_active_registry', 'wallet_fresh_sampler', 'active_minute', ['object_hmac', 'minute_start'], ['registry_version', 'watermark_at', 'sample_at', 'result'], 'one_per_active', 'one_key', null, null, 'unknown_bad', 120, 'objective_start', 'telemetry_gap'],
    ],
    objectiveSpec: [
        ['api_good', 'api', 'journey', 'end_to_end', 'event', 'edge_received_at', 'response_complete_at', 'api_eligible', 'api_success', null, 'elapsed', 1000, 0.999, true, null],
        ['core_accept', 'trading', 'journey', 'end_to_end', 'event', 'intent_validated_at', 'intent_completed_at', 'intent_eligible', 'commit_success', null, 'elapsed', 500, 0.9995, true, null],
        ['action_resolve', 'trading', 'diagnostic', 'ex_ante_qualified', 'event', 'attempt_started_at', 'resolution_committed_at', 'action_eligible', 'resolve_success', 'provider_chain', 'elapsed', 60000, 0.99, false, null],
        ['order_accept', 'trading', 'journey', 'end_to_end', 'event', 'action_committed_at', 'provider_accept_at', 'action_eligible', 'accept_success', null, 'elapsed', 5000, 0.99, true, 'order_op'],
        ['reconcile_start', 'trading', 'component', 'fervor_overhead', 'event', 'reconcile_due_at', 'reconcile_lease_at', 'action_eligible', 'stage_success', null, 'elapsed', 2000, 0.99, false, null],
        ['quote_overhead', 'trading', 'component', 'fervor_overhead', 'event', 'quote_admitted_at', 'quote_ready_at', 'intent_eligible', 'stage_success', null, 'span_sum', 75, 0.99, false, null],
        ['swap_dispatch', 'trading', 'component', 'fervor_overhead', 'event', 'signed_received_at', 'gateway_dispatch_at', 'action_eligible', 'stage_success', null, 'elapsed', 250, 0.99, false, null],
        ['swap_accept', 'trading', 'journey', 'end_to_end', 'event', 'signed_received_at', 'provider_accept_at', 'action_eligible', 'accept_success', null, 'elapsed', 5000, 0.99, true, null],
        ['swap_settle', 'trading', 'journey', 'end_to_end', 'event', 'signed_received_at', 'exact_settlement_at', 'action_eligible', 'settle_success', null, 'elapsed', 30000, 0.99, true, null],
        ['order_fresh', 'trading', 'journey', 'end_to_end', 'minute', 'order_watermark_at', 'sample_at', 'minute_eligible', 'fresh_success', null, 'age', 10000, 0.99, true, null],
        ['chain_reflect', 'trading', 'component', 'fervor_overhead', 'event', 'chain_observed_at', 'projection_ready_at', 'event_eligible', 'stage_success', null, 'elapsed', 5000, 0.99, false, null],
        ['exec_fresh', 'trading', 'journey', 'end_to_end', 'minute', 'chain_watermark_at', 'sample_at', 'minute_eligible', 'fresh_success', null, 'age', 10000, 0.99, true, null],
        ['market_fresh', 'data', 'journey', 'end_to_end', 'minute', 'market_watermark_at', 'sample_at', 'minute_eligible', 'fresh_success', null, 'age', 10000, 0.999, true, null],
        ['market_project', 'data', 'diagnostic', 'ex_ante_qualified', 'event', 'journal_committed_at', 'projection_committed_at', 'event_eligible', 'stage_success', 'market_source', 'elapsed', 250, 0.99, false, null],
        ['metric_apply', 'data', 'component', 'fervor_overhead', 'event', 'shard_received_at', 'metric_applied_at', 'event_eligible', 'stage_success', null, 'elapsed', 5, 0.99, false, null],
        ['alert_match', 'alerts', 'journey', 'end_to_end', 'event', 'journal_committed_at', 'match_completed_at', 'event_eligible', 'match_success', null, 'elapsed', 1000, 0.99, true, null],
        ['alert_lookup', 'alerts', 'component', 'fervor_overhead', 'event', 'lookup_started_at', 'lookup_done_at', 'event_eligible', 'stage_success', null, 'elapsed', 10, 0.99, false, null],
        ['alert_eval', 'alerts', 'component', 'fervor_overhead', 'event', 'eval_started_at', 'eval_done_at', 'event_eligible', 'stage_success', null, 'elapsed', 25, 0.99, false, null],
        ['notify_accept', 'notify', 'journey', 'end_to_end', 'event', 'delivery_committed_at', 'provider_accept_at', 'notify_eligible', 'notify_success', null, 'elapsed', 30000, 0.999, true, 'notify_channel'],
        ['wallet_project', 'wallet', 'component', 'fervor_overhead', 'event', 'wallet_event_at', 'wallet_projection_at', 'event_eligible', 'stage_success', null, 'elapsed', 10000, 0.99, false, null],
        ['wallet_fresh', 'wallet', 'journey', 'end_to_end', 'minute', 'wallet_watermark_at', 'sample_at', 'minute_eligible', 'fresh_success', null, 'age', 30000, 0.99, true, null],
        ['stream_delivery', 'realtime', 'journey', 'end_to_end', 'event', 'lifecycle_committed_at', 'socket_written_at', 'stream_eligible', 'stream_success', null, 'elapsed', 1000, 0.99, true, null],
        ['stream_write', 'realtime', 'component', 'fervor_overhead', 'event', 'gateway_queued_at', 'socket_written_at', 'stream_eligible', 'stream_success', null, 'elapsed', 250, 0.99, false, null],
    ],
    gateSpec: {
        duplicate_effect: [['page', 'block_release', 'freeze_scope'], ['duplicate_path_fixed', 'effects_reconciled', 'duplicate_scan_clean'], ['owner', 'sre']],
        lost_intent: [['page', 'block_release', 'freeze_scope'], ['intake_path_fixed', 'source_replayed', 'loss_scan_clean'], ['owner', 'sre']],
        invalid_tx: [['page', 'block_release', 'freeze_scope'], ['validator_fixed', 'action_reconciled', 'adversarial_replay_clean'], ['owner', 'sre', 'security']],
        excess_fill: [['page', 'block_release', 'freeze_scope'], ['fill_path_fixed', 'order_reconciled', 'custody_conserved', 'excess_scan_clean'], ['owner', 'sre']],
        ledger_gap: [['page', 'block_release', 'freeze_scope'], ['journal_path_fixed', 'journal_replayed', 'balances_conserved', 'gap_scan_clean'], ['owner', 'sre']],
        funds_gap: [['page', 'block_release', 'freeze_scope'], ['custody_path_fixed', 'wallet_reconciled', 'balances_conserved', 'obligations_cleared'], ['owner', 'sre']],
        silent_gap: [['page', 'block_release', 'mark_stale', 'freeze_scope'], ['source_path_fixed', 'source_recovered', 'overlap_replayed', 'gap_scan_clean'], ['owner', 'sre']],
        stale_epoch: [['page', 'block_release', 'freeze_global'], ['epoch_path_fixed', 'old_egress_denied', 'stale_epoch_rejected', 'active_epoch_proven'], ['owner', 'sre']],
        secret_leak: [['page', 'block_release', 'freeze_global'], ['credential_revoked', 'credential_rotated', 'exposure_reviewed', 'leak_scan_clean'], ['owner', 'sre', 'security']],
        action_overdue: [['page', 'block_release', 'freeze_scope'], ['scheduler_fixed', 'actions_reconciled', 'backlog_bounded', 'oldest_age_clean'], ['owner', 'sre']],
        unbounded_state: [['page', 'block_release', 'degrade_scope'], ['bound_fixed', 'state_bounded', 'resource_bake_clean'], ['owner', 'sre']],
        telemetry_gap: [['page', 'block_release', 'degrade_scope'], ['export_path_fixed', 'loss_window_bounded', 'unknowns_finalized_bad', 'export_soak_clean'], ['owner', 'sre']],
    },
    gateMeta: {
        duplicate_effect: ['duplicate_effect', 'fervor_order_duplicate_total', 'action'],
        lost_intent: ['lost_intent', 'fervor_order_lost_total', 'action'],
        invalid_tx: ['invalid_tx', 'fervor_tx_invalid_total', 'action'],
        excess_fill: ['excess_fill', 'fervor_fill_excess_total', 'order'],
        ledger_gap: ['ledger_gap', 'fervor_ledger_gap_total', 'order'],
        funds_gap: ['funds_gap', 'fervor_funds_gap_total', 'wallet_mint'],
        silent_gap: ['silent_gap', 'fervor_source_silent_total', 'shard'],
        stale_epoch: ['stale_epoch', 'fervor_epoch_stale_total', 'global'],
        secret_leak: ['secret_leak', 'fervor_secret_leak_total', 'global'],
        action_overdue: ['action_overdue', 'fervor_action_overdue_total', 'action'],
        unbounded_state: ['unbounded_state', 'fervor_state_unbounded_total', 'service'],
        telemetry_gap: ['telemetry_gap', 'fervor_telemetry_gap_total', 'service'],
    },
    burn: [
        ['page', '1h', '5m', 14.4],
        ['page', '6h', '30m', 6],
        ['ticket', '3d', '6h', 1],
    ],
    qualification: {
        profiles: ['orders', 'ingest', 'alerts', 'notify', 'wallet', 'gateway', 'browser', 'recovery'],
        reports: ['commit', 'image', 'fixtures', 'hardware', 'topology', 'config', 'duration', 'samples', 'quantiles', 'resources', 'loss', 'recovery', 'telemetry', 'artifacts', 'baseline'],
        run: { warmupSec: 900, measureSec: 3600, minSamples: 100000, minMinutes: 1440, resourceSec: 10, generatorHeadroomPct: 20 },
        baseline: { minRuns: 3, maxAgeDays: 30, compare: 'median', identity: ['commit', 'image', 'fixtures', 'hardware', 'topology', 'config'] },
        ingest: { traceDays: 7, rateWindowSec: 60, observedQuantile: 0.999, rateMultiplier: 2, rateFloor: 2000, byteUnit: 'bytes_per_second', byteMultiplier: 2, byteFloor: 41943040, peakSec: 3600, soakSec: 86400, soakMeanMultiplier: 1.25 },
        canary: { minSamples: 10000, minMinutes: 360, minWallMin: 30, maxWallMin: 360, compare: 'matched_control', sampleScope: 'each_objective_slice_arm', assignUnit: 'subject_hmac', assignMethod: 'keyed_hmac_bucket', assignKey: ['release', 'subject_hmac'], matchKeys: ['objective', 'slice', 'region', 'traffic_class'], exclusions: 'symmetric_pre_assignment', window: 'stage_local', observation: 'concurrent', holdbackPct: 5, stagesPct: [1, 5, 25, 50, 95] },
        artifacts: { retentionDays: 30, access: 'sre_restricted', identity: 'rotating_hmac', keyRotateDays: 30, redaction: 'canary_scan' },
        regression: { throughputDropPct: 10, p99RisePct: 20, canaryP95Pct: 20, poolWaitPct: 1 },
    },
    recoverySpec: {
        core_az: ['core_pg', 'zone', 30, [0, 0, 'sync_replica', 'all_acked_writes', 'sync_required'], [900, 'full_fenced_at'], 'full_fenced', ['replica_durable', 'old_primary_fenced', 'epoch_valid', 'invariants_clean']],
        core_region_read: ['core_pg', 'region', 60, [120, 300, 'async_wal', 'all_acked_writes', 'not_applicable'], [3600, 'read_reconcile_at'], 'read_reconcile', ['restore_verified', 'loss_bound_verified', 'reconcile_started']],
        core_region_write: ['core_pg', 'region', 60, [120, 300, 'async_wal', 'all_acked_writes', 'not_applicable'], [3600, 'mutation_safe_at'], 'mutation_safe', ['restore_verified', 'loss_bound_verified', 'external_epoch_valid', 'old_egress_denied', 'stale_epoch_rejected', 'inflight_wait_done', 'actions_reconciled', 'invariants_clean']],
        market_restore: ['market_pg', 'loss', 60, [0, 0, 'replay_overlap', 'all_committed_events', 'not_applicable'], [3600, 'stale_read_at'], 'stale_read', ['checkpoint_loaded', 'replay_window_216000', 'overlap_1500_slots', 'gap_scan_clean']],
        redis_rebuild: ['redis', 'loss', 30, [0, 0, 'rebuildable', 'all_durable_state', 'not_applicable'], [600, 'redrive_ready_at'], 'rebuild', ['pg_redrive_ready', 'pel_reconciled', 'streams_bounded']],
    },
};

const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const mapBy = (items, key, name, errors) => {
    const map = new Map();
    for (const item of items || []) {
        if (map.has(item[key])) errors.push(`${name} key is duplicated: ${item[key]}`);
        map.set(item[key], item);
    }
    return map;
};
const mapById = (items, name, errors) => mapBy(items, 'id', name, errors);

const semanticErrors = (value, regionCount = regions.regions.length) => {
    const errors = [];
    const domains = mapById(value.domains, 'domain', errors);
    const eligibility = mapById(value.eligibility, 'eligibility', errors);
    const proofs = mapById(value.proofs, 'proof', errors);
    const pairs = mapById(value.pairs, 'pair set', errors);
    const results = mapById(value.results, 'result', errors);
    const qualifiers = mapById(value.qualifiers, 'qualifier', errors);
    const objectives = mapById(value.objectives, 'objective', errors);
    const cohorts = mapBy(value.cohorts, 'objective', 'cohort', errors);
    mapById(value.gates, 'gate', errors);
    const recovery = mapById(value.recovery, 'recovery', errors);
    mapById(value.safety, 'safety', errors);
    mapById(value.telemetry?.instruments, 'instrument', errors);

    if (!same([...domains.keys()], Object.keys(expected.domains))) errors.push('domain set or order changed');
    for (const [id, values] of Object.entries(expected.domains)) {
        if (!same(domains.get(id)?.values, values)) errors.push(`${id} reviewed vocabulary changed`);
    }

    for (const partition of value.eligibility || []) {
        const domain = domains.get(partition.domain);
        if (!domain) {
            errors.push(`${partition.id} references unknown domain ${partition.domain}`);
            continue;
        }
        const include = new Set(partition.include);
        const exclude = new Set(partition.exclude);
        if ([...include].some((item) => exclude.has(item))) errors.push(`${partition.id} overlaps include and exclude`);
        if (!same([...new Set([...partition.include, ...partition.exclude])].sort(), [...domain.values].sort())) {
            errors.push(`${partition.id} is not an exhaustive ${partition.domain} partition`);
        }
        const reviewed = expected.eligibility[partition.id];
        const reviewedDomain = `${partition.id.replace('_eligible', '')}_admit`;
        if (!reviewed || partition.domain !== reviewedDomain
            || !same([partition.include, partition.exclude], reviewed)) {
            errors.push(`${partition.id} reviewed eligibility changed`);
        }
    }
    if (!same([...eligibility.keys()], Object.keys(expected.eligibility))) errors.push('eligibility set or order changed');

    const proofSpec = (value.proofs || []).map((proof) => [
        proof.id,
        proof.fields.map((field) => [field.id, field.claim, field.source, field.phase, field.maxAgeMs]),
    ]);
    if (!same(proofSpec, expected.proofSpec)) errors.push('reviewed immutable proof contract changed');
    for (const proof of value.proofs || []) {
        if (new Set(proof.fields.map((field) => field.id)).size !== proof.fields.length) {
            errors.push(`${proof.id} repeats a proof field`);
        }
    }

    if (!same([...pairs.keys()], ['api_pairs'])) errors.push('admission/result pair set changed');
    const apiPairs = pairs.get('api_pairs');
    if (apiPairs?.admitDomain !== 'api_admit' || apiPairs?.resultDomain !== 'api_result') {
        errors.push('API pair domains changed');
    } else {
        const admissions = new Set();
        const outcomes = new Set();
        const combinations = new Set();
        for (const rule of apiPairs.rules) {
            admissions.add(rule.admission);
            outcomes.add(rule.outcome);
            const combination = `${rule.admission}\u0000${rule.outcome}`;
            if (combinations.has(combination)) errors.push(`api_pairs repeats ${rule.admission}/${rule.outcome}`);
            combinations.add(combination);
            if (!domains.get('api_admit')?.values.includes(rule.admission)) {
                errors.push(`api_pairs uses unknown admission ${rule.admission}`);
            }
            if (!domains.get('api_result')?.values.includes(rule.outcome)) {
                errors.push(`api_pairs.${rule.admission} uses unknown outcome ${rule.outcome}`);
            }
            if (!proofs.has(rule.proofRef)) {
                errors.push(`api_pairs.${rule.admission}/${rule.outcome} references unknown proof ${rule.proofRef}`);
            }
        }
        if (!same([...admissions], domains.get('api_admit')?.values)) {
            errors.push('api_pairs does not map every admission');
        }
        if (!same([...outcomes].sort(), [...(domains.get('api_result')?.values || [])].sort())) {
            errors.push('api_pairs does not cover every API result');
        }
        const pairSpec = apiPairs.rules.map((rule) => [rule.admission, rule.outcome, rule.grade, rule.proofRef]);
        if (!same(pairSpec, expected.pairSpec)) errors.push('reviewed API pair/proof contract changed');
    }

    for (const result of value.results || []) {
        const domain = domains.get(result.domain);
        if (!domain) {
            errors.push(`${result.id} references unknown domain ${result.domain}`);
            continue;
        }
        const good = new Set(result.good);
        if (result.bad.some((item) => good.has(item))) errors.push(`${result.id} overlaps good and bad`);
        if (!same([...new Set([...result.good, ...result.bad])].sort(), [...domain.values].sort())) {
            errors.push(`${result.id} is not an exhaustive ${result.domain} partition`);
        }
        const reviewed = expected.results[result.id];
        const reviewedDomains = {
            api_success: 'api_result',
            commit_success: 'commit_result',
            resolve_success: 'resolve_result',
            accept_success: 'accept_result',
            stage_success: 'stage_result',
            match_success: 'match_result',
            fresh_success: 'fresh_result',
            settle_success: 'settle_result',
            notify_success: 'notify_result',
            stream_success: 'stream_result',
        };
        if (!reviewed || result.domain !== reviewedDomains[result.id]
            || !same([result.good, result.bad], reviewed)) {
            errors.push(`${result.id} reviewed grading changed`);
        }
    }
    if (!same([...results.keys()], Object.keys(expected.results))) errors.push('result set or order changed');

    for (const qualifier of value.qualifiers || []) {
        if (!qualifier.states.includes(qualifier.healthy)) errors.push(`${qualifier.id} healthy state is not declared`);
        if (!qualifier.states.includes('unknown')) errors.push(`${qualifier.id} must declare unknown`);
        if (qualifier.healthy === 'unknown') errors.push(`${qualifier.id} treats unknown as healthy`);
    }
    const qualifierSpec = (value.qualifiers || []).map((item) => [
        item.id, item.phase, item.maxAgeMs, item.states, item.healthy,
        item.unhealthy, item.unknown, item.missing, item.stale, item.wrongPhase,
    ]);
    const reviewedQualifiers = [
        ['provider_chain', 'before_start', 5000, ['healthy', 'unhealthy', 'unknown'], 'healthy', 'excluded', 'qualification_fault', 'qualification_fault', 'qualification_fault', 'qualification_fault'],
        ['market_source', 'before_start', 5000, ['healthy', 'unhealthy', 'unknown'], 'healthy', 'excluded', 'qualification_fault', 'qualification_fault', 'qualification_fault', 'qualification_fault'],
    ];
    if (!same(qualifierSpec, reviewedQualifiers)) errors.push('qualifier truth contract changed');

    for (const objective of value.objectives || []) {
        if (!eligibility.has(objective.eligibilityRef)) errors.push(`${objective.id} has unknown eligibilityRef`);
        if (!results.has(objective.resultRef)) errors.push(`${objective.id} has unknown resultRef`);
        if (objective.qualifierRef !== null && !qualifiers.has(objective.qualifierRef)) {
            errors.push(`${objective.id} has unknown qualifierRef`);
        }
        if (objective.sliceRef !== null && !domains.has(objective.sliceRef)) errors.push(`${objective.id} has unknown sliceRef`);
        if (objective.class === 'journey' && (objective.basis !== 'end_to_end' || !objective.budget)) {
            errors.push(`${objective.id} journey must be an end-to-end budget objective`);
        }
        if (objective.class === 'component' && (objective.basis !== 'fervor_overhead' || objective.budget)) {
            errors.push(`${objective.id} component must be non-budget Fervor overhead`);
        }
        if (objective.class === 'diagnostic' && (objective.basis !== 'ex_ante_qualified' || objective.budget)) {
            errors.push(`${objective.id} diagnostic must be non-budget and ex-ante qualified`);
        }
        if (objective.measure === 'span_sum' && objective.id !== 'quote_overhead') {
            errors.push(`${objective.id} is not approved for span-sum measurement`);
        }
    }

    const objectiveSpec = (value.objectives || []).map((item) => [
        item.id, item.owner, item.class, item.basis, item.sample, item.start, item.stop,
        item.eligibilityRef, item.resultRef, item.qualifierRef, item.measure, item.thresholdMs,
        item.target, item.budget, item.sliceRef,
    ]);
    if (!same(objectiveSpec, expected.objectiveSpec)) errors.push('reviewed objective semantics changed');

    if (!same(value.objectives?.map((item) => item.id), expected.objectives)) errors.push('objective set or order changed');
    const journeys = value.objectives?.filter((item) => item.class === 'journey').map((item) => item.id);
    if (!same(journeys, expected.journeys)) errors.push('mandatory user-journey objective set changed');
    const cohortSpec = (value.cohorts || []).map((item) => [
        item.objective, item.registry, item.observer, item.mode, item.key, item.required,
        item.complete, item.focus, item.effectField, item.effectStore, item.missing,
        item.finalizeSec, item.deadlineFrom, item.gate,
    ]);
    if (!same(cohortSpec, expected.cohortSpec)) errors.push('reviewed cohort obligation contract changed');
    for (const cohort of value.cohorts || []) {
        const objective = objectives.get(cohort.objective);
        if (!objective) {
            errors.push(`${cohort.objective} cohort references an unknown objective`);
            continue;
        }
        if (cohort.mode === 'active_minute' && objective.sample !== 'minute') {
            errors.push(`${cohort.objective} active-minute cohort is not a minute objective`);
        }
        if (cohort.mode === 'event_snapshot' && objective.sample !== 'event') {
            errors.push(`${cohort.objective} event-snapshot cohort is not an event objective`);
        }
    }
    if (!same(value.gates?.map((item) => item.id), expected.gates)) errors.push('correctness gate set or order changed');
    if (!same(value.recovery?.map((item) => item.id), expected.recovery)) errors.push('recovery set or order changed');
    if (!same(value.safety?.map((item) => item.id), expected.safety)) errors.push('safety set or order changed');

    const apiAdmit = domains.get('api_admit')?.values;
    const apiResult = domains.get('api_result')?.values;
    if (!same(apiAdmit, expected.domains.api_admit)) {
        errors.push('API admission taxonomy changed');
    }
    if (!same(apiResult, expected.domains.api_result)) {
        errors.push('API semantic outcome taxonomy changed');
    }

    for (const gate of value.gates || []) {
        if (!gate.actions.includes('page') || !gate.actions.includes('block_release')) {
            errors.push(`${gate.id} must page and block release`);
        }
        const runtime = ['freeze_scope', 'freeze_global', 'degrade_scope', 'mark_stale'];
        if (!gate.actions.some((action) => runtime.includes(action))) errors.push(`${gate.id} lacks a runtime guard`);
        if (gate.scope === 'global' && !gate.actions.includes('freeze_global')) errors.push(`${gate.id} must freeze globally`);
        const reviewed = expected.gateSpec[gate.id];
        const reviewedMeta = expected.gateMeta[gate.id];
        if (!reviewed || gate.rearm.mode !== 'all' || gate.rearm.baseline !== 'after_evidence'
            || !same([gate.actions, gate.rearm.proofs, gate.rearm.ackRoles], reviewed)
            || !same([gate.event, gate.metric, gate.scope], reviewedMeta)) {
            errors.push(`${gate.id} reviewed runtime or rearm contract changed`);
        }
    }

    for (const item of value.recovery || []) {
        if (item.dataRpo.bound !== 'unbounded' && item.dataRpo.targetSec > item.dataRpo.maxSec) {
            errors.push(`${item.id} RPO target exceeds its maximum`);
        }
        const reviewed = expected.recoverySpec[item.id];
        const spec = [
            item.store,
            item.fault,
            item.detectSec,
            [item.dataRpo.targetSec, item.dataRpo.maxSec, item.dataRpo.bound, item.dataRpo.lossScope, item.dataRpo.ackGuard],
            [item.rto.targetSec, item.rto.stop],
            item.resume,
            item.proofs,
        ];
        if (!reviewed || item.rto.mode !== 'time' || item.rto.start !== 'fault_at' || !same(spec, reviewed)) {
            errors.push(`${item.id} reviewed recovery contract changed`);
        }
    }
    const regionRead = recovery.get('core_region_read')?.dataRpo;
    const regionWrite = recovery.get('core_region_write')?.dataRpo;
    if (!same(regionRead, regionWrite)) errors.push('core region read and write must use one data-loss bound');
    const marketProofs = recovery.get('market_restore')?.proofs || [];
    for (const proof of ['replay_window_216000', 'overlap_1500_slots', 'gap_scan_clean']) {
        if (!marketProofs.includes(proof)) errors.push(`market_restore lacks ${proof}`);
    }
    const epochResume = value.safety?.find((item) => item.id === 'epoch_resume');
    if (!epochResume || epochResume.fault !== 'authority' || epochResume.action !== 'disable_mutation'
        || !same(epochResume.proofs, ['external_epoch_valid', 'stale_epoch_rejected', 'old_egress_denied', 'inflight_wait_done'])) {
        errors.push('epoch resume safety proof changed');
    }

    let totalSeries = 0;
    const basisValues = new Set((value.objectives || []).map((item) => item.basis)).size;
    const sliceValues = new Set(['none']);
    for (const objective of value.objectives || []) {
        const domain = domains.get(objective.sliceRef);
        for (const item of domain?.values || []) sliceValues.add(item);
    }
    const labelValues = {
        slo: objectives.size,
        grade: value.telemetry?.grades?.length,
        basis: basisValues,
        region: regionCount,
        qualifier: qualifiers.size,
        slice: sliceValues.size,
    };
    const labelSources = {
        slo: 'contract',
        grade: 'fixed',
        basis: 'fixed',
        region: 'deploy_registry',
        qualifier: 'contract',
        slice: 'contract',
    };
    const instrumentSpec = {
        slo_events_v2: ['fervor_slo_events_total', 'counter', ['slo', 'grade', 'basis', 'region', 'slice']],
        slo_duration_v2: ['fervor_slo_duration_seconds', 'histogram', ['slo', 'basis', 'region', 'slice']],
        qualifier_fault: ['fervor_slo_qualifier_total', 'counter', ['qualifier', 'region']],
    };
    for (const instrument of value.telemetry?.instruments || []) {
        const names = instrument.labels.map((label) => label.name);
        if (new Set(names).size !== names.length) errors.push(`${instrument.id} repeats a label`);
        if (names.some((name) => value.telemetry.forbiddenLabels.includes(name))) {
            errors.push(`${instrument.id} uses a forbidden label`);
        }
        const reviewed = instrumentSpec[instrument.id];
        if (!reviewed || instrument.metric !== reviewed[0] || instrument.kind !== reviewed[1]
            || !same(names, reviewed[2])) errors.push(`${instrument.id} instrument contract changed`);
        for (const label of instrument.labels) {
            if (label.maxValues !== labelValues[label.name] || label.source !== labelSources[label.name]) {
                errors.push(`${instrument.id}.${label.name} vocabulary is not derived from its source`);
            }
        }
        const product = instrument.labels.reduce((count, label) => count * labelValues[label.name], 1);
        let factor = 1;
        if (instrument.kind === 'histogram') {
            const buckets = instrument.bucketsSec || [];
            if (buckets.some((item) => !Number.isFinite(item) || item <= 0)) {
                errors.push(`${instrument.id} has an invalid histogram bucket`);
            }
            for (let index = 1; index < buckets.length; index += 1) {
                if (buckets[index] <= buckets[index - 1]) errors.push(`${instrument.id} buckets are not strictly increasing`);
                if (buckets[index] / buckets[index - 1] > 4) errors.push(`${instrument.id} buckets are too sparse`);
            }
            const thresholds = (value.objectives || [])
                .filter((item) => item.histogram === instrument.id)
                .map((item) => item.thresholdMs / 1000);
            if (thresholds.some((item) => !buckets.includes(item))) {
                errors.push(`${instrument.id} lacks an exact objective-threshold bucket`);
            }
            if (buckets[0] >= Math.min(...thresholds) || buckets.at(-1) <= Math.max(...thresholds)) {
                errors.push(`${instrument.id} does not bound values below and above objective thresholds`);
            }
            factor = buckets.length + 3;
        } else if (instrument.bucketsSec.length !== 0) {
            errors.push(`${instrument.id} counter declares histogram buckets`);
        }
        const calculated = product * factor;
        if (calculated !== instrument.maxSeries) errors.push(`${instrument.id} series budget should be ${calculated}`);
        totalSeries += calculated;
    }
    if (!same((value.telemetry?.instruments || []).map((item) => item.id), Object.keys(instrumentSpec))) {
        errors.push('telemetry instrument set or order changed');
    }
    if (totalSeries > value.telemetry?.maxSeries) errors.push(`telemetry series ${totalSeries} exceeds the global limit`);
    if (value.telemetry?.maxSeries !== 50000) errors.push('global telemetry series budget changed');
    if (!same(value.telemetry?.grades, ['good', 'bad', 'excluded'])) errors.push('telemetry grade vocabulary changed');
    const forbiddenLabels = ['wallet', 'user', 'token', 'order', 'action', 'signature', 'request', 'recipient', 'error_text', 'url', 'trace_id', 'release', 'service'];
    if (!same(value.telemetry?.forbiddenLabels, forbiddenLabels)) errors.push('forbidden metric label policy changed');
    if (!value.telemetry?.forbiddenLabels.includes('release') || !value.telemetry?.forbiddenLabels.includes('service')) {
        errors.push('resource attributes must not become release or service metric labels');
    }

    const burnSpec = (value.burn || []).map((item) => [item.severity, item.long, item.short, item.rate]);
    if (!same(burnSpec, expected.burn)) errors.push('reviewed burn-rate contract changed');
    if (!same(value.qualification, expected.qualification)) errors.push('reviewed qualification contract changed');
    if (!same(value.qualification?.profiles, expected.profiles)) errors.push('qualification profile set changed');
    if (!same(value.qualification?.reports, expected.reports)) errors.push('qualification report set changed');
    const canary = value.qualification?.canary;
    if (canary?.stagesPct?.at(-1) !== 100 - canary?.holdbackPct) {
        errors.push('canary ladder must preserve its matched-control holdback');
    }
    for (let index = 1; index < (canary?.stagesPct?.length ?? 0); index += 1) {
        if (canary.stagesPct[index] <= canary.stagesPct[index - 1]) {
            errors.push('canary stages must be strictly increasing');
        }
    }
    if (canary?.compare !== 'matched_control' || canary?.sampleScope !== 'each_objective_slice_arm'
        || canary?.assignMethod !== 'keyed_hmac_bucket' || canary?.window !== 'stage_local'
        || canary?.observation !== 'concurrent' || canary?.exclusions !== 'symmetric_pre_assignment'
        || canary?.holdbackPct !== 5
        || !same(canary?.stagesPct, [1, 5, 25, 50, 95])) {
        errors.push('reviewed canary control contract changed');
    }
    if (value.qualification?.canary?.minWallMin > value.qualification?.canary?.maxWallMin) {
        errors.push('canary minimum wall time exceeds its maximum');
    }
    return errors;
};

const accepts = (value) => targetSchema.validate(value) && semanticErrors(value).length === 0;
if (!accepts(targets)) {
    throw new Error(`SLO targets are invalid:\n${targetSchema.explain()}\n${semanticErrors(targets).join('\n')}`);
}
if (!caseSchema.validate(cases)) throw new Error(`SLO cases are invalid:\n${caseSchema.explain()}`);
for (const version of [1, 2, 3, 4, 5, 7]) {
    const incompatible = clone(cases);
    incompatible.schema = version;
    if (caseSchema.validate(incompatible)) throw new Error(`Fixture schema ${version} was accepted as schema 6`);
}

const captureKeys = new Map([
    'route_registry',
    'action_ledger',
    'idem_ledger',
    'edge_proxy',
    'edge_parser',
    'auth_gateway',
    'policy_store',
    'quota_ledger',
    'traffic_registry',
].map((source) => [`${source}\u0000fixture_v1`, `fixture-only:${source}`]));
const bindingKeys = new Map([
    ['slo_classifier\u0000fixture_v1', 'fixture-only:slo_classifier'],
]);
const effectKeys = new Map([
    ['alert_effect_store\u0000fixture_v1', 'fixture-only:alert_effect_store'],
]);
const captureBody = (capture) => JSON.stringify([
    capture.keyVersion,
    capture.eventId,
    capture.requestHmac,
    capture.resultTxn,
    capture.field,
    capture.claim,
    capture.source,
    capture.phase,
    capture.capturedAtMs,
    capture.payload,
]);
const bindingBody = (proof) => JSON.stringify([
    proof.keyVersion,
    proof.issuer,
    proof.eventId,
    proof.requestHmac,
    proof.resultTxn,
    proof.objective,
    proof.admission,
    proof.outcome,
    proof.profile,
    proof.field,
    proof.captureDigest,
    proof.startAtMs,
    proof.resultAtMs,
    proof.evaluatedAtMs,
    proof.boundAtMs,
]);
const effectBody = (effect) => JSON.stringify([
    effect.keyVersion,
    effect.source,
    effect.receiptId,
    effect.cohortId,
    effect.eventId,
    effect.requestHmac,
    effect.resultTxn,
    effect.ruleHmac,
    effect.committedAtMs,
]);
const attest = {
    capture: {
        body: captureBody,
        key: (item) => captureKeys.get(`${item.source}\u0000${item.keyVersion}`),
        label: (item) => `${item.source}/${item.keyVersion}`,
    },
    binding: {
        body: bindingBody,
        key: (item) => bindingKeys.get(`${item.issuer}\u0000${item.keyVersion}`),
        label: (item) => `${item.issuer}/${item.keyVersion}`,
    },
    effect: {
        body: effectBody,
        key: (item) => effectKeys.get(`${item.source}\u0000${item.keyVersion}`),
        label: (item) => `${item.source}/${item.keyVersion}`,
    },
};
const expectedAttestMac = (kind, item) => {
    const key = attest[kind].key(item);
    return key ? createHmac('sha256', key).update(attest[kind].body(item)).digest('hex') : null;
};
const attestDigest = (kind, item) => createHash('sha256')
    .update(attest[kind].body(item))
    .update('\u0000')
    .update(item.mac)
    .digest('hex');
const validAttestation = (kind, item) => {
    const expectedMac = expectedAttestMac(kind, item);
    if (!expectedMac || !/^[a-f0-9]{64}$/.test(item.mac ?? '')
        || !/^[a-f0-9]{64}$/.test(item.digest ?? '')) return false;
    return timingSafeEqual(Buffer.from(expectedMac, 'hex'), Buffer.from(item.mac, 'hex'))
        && attestDigest(kind, item) === item.digest;
};
const sealAttestation = (kind, item) => {
    item.mac = expectedAttestMac(kind, item);
    if (!item.mac) throw new Error(`Fixture ${kind} uses an untrusted key: ${attest[kind].label(item)}`);
    item.digest = attestDigest(kind, item);
    return item;
};
const indexAttestations = (kind, records) => {
    const indexed = new Map();
    for (const item of records) {
        const existing = indexed.get(item.digest);
        if (existing) {
            existing.valid = false;
            continue;
        }
        indexed.set(item.digest, { item, valid: validAttestation(kind, item) });
    }
    return indexed;
};
const createEffectIndex = (records = []) => {
    const indexed = new Map();
    const receipts = new Map();
    const add = (item, valid = validAttestation('effect', item)) => {
        let entry = indexed.get(item.digest);
        if (entry) {
            entry.valid = false;
        } else {
            entry = { item, valid };
            indexed.set(item.digest, entry);
        }
        const owner = receipts.get(item.receiptId);
        if (owner && owner !== entry) {
            owner.valid = false;
            entry.valid = false;
        } else if (!owner) {
            receipts.set(item.receiptId, entry);
        }
        return entry;
    };
    for (const item of records) add(item);
    return { records: indexed, add };
};
const captureRecords = indexAttestations('capture', cases.captures);
const proofRecords = indexAttestations('binding', cases.proofs);
const effectIndex = createEffectIndex(cases.effects);
const effectRecords = effectIndex.records;
const resolveAttestation = (records, digest) => {
    const entry = records.get(digest);
    return entry?.valid ? entry.item : null;
};
for (const [kind, sample] of [
    ['capture', cases.captures[0]],
    ['binding', cases.proofs[0]],
    ['effect', cases.effects[0]],
]) {
    for (const field of ['mac', 'digest']) {
        const malformed = { ...sample, [field]: 'zz' };
        for (const records of [[sample, malformed], [malformed, sample]]) {
            const indexed = kind === 'effect'
                ? createEffectIndex(records).records
                : indexAttestations(kind, records);
            const accepted = field === 'mac'
                ? resolveAttestation(indexed, sample.digest)
                : resolveAttestation(indexed, malformed.digest);
            if (accepted) {
                throw new Error(`${kind} valid/invalid ${field} duplicate accepted by arrival order`);
            }
        }
    }
}
{
    const first = clone(cases.effects[0]);
    const second = sealAttestation('effect', {
        ...clone(first),
        ruleHmac: `${first.ruleHmac}_collision`,
    });
    if (first.digest === second.digest || first.receiptId !== second.receiptId) {
        throw new Error('Effect receipt collision test is not identity-isolated');
    }
    for (const records of [[first, second], [second, first]]) {
        const indexed = createEffectIndex(records).records;
        if (resolveAttestation(indexed, first.digest) || resolveAttestation(indexed, second.digest)) {
            throw new Error('Duplicate durable effect receipt identity accepted by arrival order');
        }
    }
}

const lookup = (items, id) => items.find((item) => item.id === id);
const cohortKeys = new Map([
    'alert_rule_registry',
    'alert_matcher',
    'order_active_registry',
    'order_fresh_sampler',
    'execution_active_registry',
    'exec_fresh_sampler',
    'market_shard_registry',
    'market_fresh_sampler',
    'wallet_active_registry',
    'wallet_fresh_sampler',
].map((source) => [`${source}\u0000fixture_v1`, `fixture-only:${source}`]));
const cohortBody = (kind, cohort, record) => JSON.stringify(kind === 'registry'
    ? [kind, cohort.id, cohort.objective, record.keyVersion, record.source,
        record.eventId, record.requestHmac, record.snapshotAtMs,
        record.version, record.watermark, record.rows]
    : [kind, cohort.id, cohort.objective, record.keyVersion, record.source,
        record.registryDigest, record.eventId, record.requestHmac, record.resultTxn,
        record.startAtMs, record.resultAtMs, record.evaluatedAtMs, record.finalizedAtMs,
        record.focusKey, record.rows]);
const expectedCohortMac = (kind, cohort, record) => {
    const key = cohortKeys.get(`${record.source}\u0000${record.keyVersion}`);
    return key ? createHmac('sha256', key).update(cohortBody(kind, cohort, record)).digest('hex') : null;
};
const cohortDigest = (kind, cohort, record) => createHash('sha256')
    .update(cohortBody(kind, cohort, record))
    .update('\u0000')
    .update(record.mac)
    .digest('hex');
const validCohortMac = (kind, cohort, record) => {
    const expectedMac = expectedCohortMac(kind, cohort, record);
    if (!expectedMac || !/^[a-f0-9]{64}$/.test(record.mac ?? '')
        || !/^[a-f0-9]{64}$/.test(record.digest ?? '')) return false;
    return timingSafeEqual(Buffer.from(expectedMac, 'hex'), Buffer.from(record.mac, 'hex'))
        && cohortDigest(kind, cohort, record) === record.digest;
};
const sealCohort = (cohort) => {
    for (const kind of ['registry', 'terminal']) {
        const record = cohort[kind];
        if (kind === 'terminal') record.registryDigest = cohort.registry.digest;
        record.mac = expectedCohortMac(kind, cohort, record);
        if (!record.mac) throw new Error(`Fixture cohort uses an untrusted source/key: ${record.source}/${record.keyVersion}`);
        record.digest = cohortDigest(kind, cohort, record);
    }
    return cohort;
};
const indexCohorts = (cohorts) => {
    const records = new Map();
    const digests = new Map();
    for (const cohort of cohorts) {
        const entry = {
            item: cohort,
            valid: ['registry', 'terminal'].every((kind) => validCohortMac(kind, cohort, cohort[kind])),
        };
        const duplicate = records.get(cohort.id);
        if (duplicate) {
            duplicate.valid = false;
            entry.valid = false;
        } else {
            records.set(cohort.id, entry);
        }
        for (const kind of ['registry', 'terminal']) {
            const owner = digests.get(cohort[kind].digest);
            if (owner) {
                owner.valid = false;
                entry.valid = false;
            } else {
                digests.set(cohort[kind].digest, entry);
            }
        }
    }
    return { records, digests };
};
const cohortIndex = indexCohorts(cases.cohorts);
const cohortRecords = cohortIndex.records;
for (const kind of ['registry', 'terminal']) {
    const tampered = clone(cases.cohorts[0]);
    tampered[kind].rows = clone(tampered[kind].rows);
    tampered[kind].rows.push(...tampered[kind].rows.slice(0, 1));
    if (validCohortMac(kind, tampered, tampered[kind])) {
        throw new Error(`Tampered cohort ${kind} proof was accepted`);
    }
    for (const field of ['mac', 'digest']) {
        const malformed = clone(cases.cohorts[0]);
        malformed[kind][field] = 'zz';
        if (validCohortMac(kind, malformed, malformed[kind])) {
            throw new Error(`Malformed cohort ${kind} ${field} was accepted`);
        }
    }
}
{
    const original = clone(cases.cohorts[0]);
    const duplicateId = clone(original);
    duplicateId.registry.version = 'duplicate_id_v1';
    sealCohort(duplicateId);
    const duplicateDigest = clone(original);
    duplicateDigest.id = `${original.id}_digest_claimant`;
    for (const pair of [[original, duplicateId], [duplicateId, original]]) {
        if (indexCohorts(pair).records.get(original.id)?.valid !== false) {
            throw new Error('Duplicate cohort ID accepted by arrival order');
        }
    }
    for (const pair of [[original, duplicateDigest], [duplicateDigest, original]]) {
        if ([...indexCohorts(pair).records.values()].some((entry) => entry.valid)) {
            throw new Error('Duplicate cohort digest accepted by arrival order');
        }
    }
}
const rowKey = (row, contract) => {
    if (!row?.key || typeof row.key !== 'object' || Array.isArray(row.key)) return null;
    const actual = Object.keys(row.key).sort();
    const required = [...contract.key].sort();
    if (!same(actual, required)) return null;
    return JSON.stringify(contract.key.map((key) => row.key[key]));
};
const cohortState = (fixture, contract) => {
    const deadlineAtMs = fixture.startAtMs + contract.finalizeSec * 1000;
    if (!fixture.cohortRef) return fixture.evaluatedAtMs < deadlineAtMs ? 'pending' : 'bad';
    const entry = cohortRecords.get(fixture.cohortRef);
    const observed = entry?.valid ? entry.item : null;
    if (!observed || observed.objective !== contract.objective
        || observed.registry.source !== contract.registry
        || observed.registry.eventId !== fixture.eventId
        || observed.registry.requestHmac !== fixture.requestHmac
        || observed.registry.snapshotAtMs !== fixture.startAtMs
        || observed.terminal.source !== contract.observer
        || !validCohortMac('registry', observed, observed.registry)
        || !validCohortMac('terminal', observed, observed.terminal)
        || observed.terminal.registryDigest !== observed.registry.digest
        || observed.terminal.eventId !== fixture.eventId
        || observed.terminal.requestHmac !== fixture.requestHmac
        || observed.terminal.resultTxn !== fixture.resultTxn
        || observed.terminal.startAtMs !== fixture.startAtMs
        || observed.terminal.resultAtMs !== fixture.resultAtMs
        || observed.terminal.evaluatedAtMs !== fixture.evaluatedAtMs
        || observed.terminal.finalizedAtMs !== fixture.resultAtMs
        || observed.terminal.finalizedAtMs > deadlineAtMs
        || !observed.registry.watermark) return 'bad';

    const registry = new Map();
    for (const row of observed.registry.rows) {
        const key = rowKey(row, contract);
        if (!key || registry.has(key)) return 'bad';
        registry.set(key, row);
    }
    const terminal = new Map();
    for (const row of observed.terminal.rows) {
        const key = rowKey(row, contract);
        if (!key || terminal.has(key) || !registry.has(key)
            || !same(Object.keys(row.fields).sort(), [...contract.required].sort())) return 'bad';
        terminal.set(key, row);
    }
    if (terminal.size !== registry.size) return 'bad';

    if (contract.focus === 'one_key') {
        const objective = lookup(targets.objectives, contract.objective);
        const result = objective && lookup(targets.results, objective.resultRef);
        const allowedResults = new Set([...(result?.good ?? []), ...(result?.bad ?? [])]);
        const focus = rowKey({ key: observed.terminal.focusKey }, contract);
        const focusRow = focus && terminal.get(focus);
        if (!focusRow || ![...terminal.values()].every(({ fields }) => fields.registry_version === observed.registry.version
            && Number.isSafeInteger(fields.watermark_at)
            && Number.isSafeInteger(fields.sample_at)
            && fields.sample_at >= fields.watermark_at
            && fields.sample_at <= observed.terminal.finalizedAtMs
            && allowedResults.has(fields.result))) return 'bad';
        return focusRow.fields.watermark_at === fixture.startAtMs
            && focusRow.fields.sample_at === fixture.resultAtMs
            && focusRow.fields.result === fixture.outcome ? 'valid' : 'bad';
    }
    if (contract.focus !== 'event_all' || observed.terminal.focusKey !== null) return 'bad';

    const eventKeys = contract.key.filter((key) => key !== 'rule_hmac');
    const eventKey = (row) => JSON.stringify(eventKeys.map((key) => row.key[key]));
    const expectedCounts = new Map();
    const observedCounts = new Map();
    for (const row of registry.values()) {
        if (row.key.event_id !== fixture.eventId
            || row.key.snapshot_version !== observed.registry.version) return 'bad';
        const key = eventKey(row);
        expectedCounts.set(key, (expectedCounts.get(key) ?? 0) + 1);
    }
    if (expectedCounts.size > 1) return 'bad';
    if (registry.size === 0) return fixture.outcome === 'no_match' ? 'valid' : 'bad';
    const effectDigests = new Set();
    const receiptIds = new Set();
    const results = [];
    for (const row of terminal.values()) {
        const { fields } = row;
        const key = eventKey(row);
        observedCounts.set(key, (observedCounts.get(key) ?? 0) + 1);
        if (fields.snapshot_version !== observed.registry.version
            || fields.coverage_watermark !== true
            || !Number.isSafeInteger(fields.rule_count)
            || !Number.isSafeInteger(fields.eval_count)
            || !['matched', 'no_match', 'failed'].includes(fields.result)) return 'bad';
        results.push(fields.result);
        if (fields.result === 'matched') {
            if (typeof fields[contract.effectField] !== 'string'
                || effectDigests.has(fields[contract.effectField])) return 'bad';
            effectDigests.add(fields[contract.effectField]);
            const effect = resolveAttestation(effectRecords, fields[contract.effectField]);
            if (effect?.source !== contract.effectStore
                || receiptIds.has(effect.receiptId)
                || effect.cohortId !== observed.id
                || effect.eventId !== fixture.eventId
                || effect.requestHmac !== fixture.requestHmac
                || effect.resultTxn !== fixture.resultTxn
                || effect.ruleHmac !== row.key.rule_hmac
                || effect.committedAtMs < fixture.startAtMs
                || effect.committedAtMs > fixture.resultAtMs) return 'bad';
            receiptIds.add(effect.receiptId);
        } else if (fields[contract.effectField] !== null) return 'bad';
    }
    for (const row of terminal.values()) {
        const key = eventKey(row);
        if (row.fields.rule_count !== expectedCounts.get(key)
            || row.fields.eval_count !== observedCounts.get(key)) return 'bad';
    }
    if (fixture.outcome === 'matched') {
        return results.includes('matched') && results.every((item) => ['matched', 'no_match'].includes(item))
            ? 'valid' : 'bad';
    }
    if (fixture.outcome === 'no_match') return results.every((item) => item === 'no_match') ? 'valid' : 'bad';
    return results.every((item) => item === fixture.outcome) ? 'valid' : 'bad';
};
const observedProofs = (rule, fixture, value = targets) => {
    const proof = lookup(value.proofs, rule.proofRef);
    if (!proof) return [];
    return proof.fields.map((field) => {
        const capture = sealAttestation('capture', {
            keyVersion: 'fixture_v1',
            eventId: fixture.eventId,
            requestHmac: fixture.requestHmac,
            resultTxn: field.phase === 'after_result' ? fixture.resultTxn : null,
            field: field.id,
            claim: field.claim,
            source: field.source,
            phase: field.phase,
            capturedAtMs: field.phase === 'before_start' ? fixture.startAtMs : fixture.resultAtMs,
            payload: `matrix:${proof.id}:${field.id}`,
        });
        captureRecords.set(capture.digest, { item: capture, valid: true });
        const binding = sealAttestation('binding', {
            keyVersion: 'fixture_v1',
            issuer: 'slo_classifier',
            eventId: fixture.eventId,
            requestHmac: fixture.requestHmac,
            resultTxn: fixture.resultTxn,
            objective: fixture.objective,
            admission: fixture.admission,
            outcome: fixture.outcome,
            profile: proof.id,
            field: field.id,
            captureDigest: capture.digest,
            startAtMs: fixture.startAtMs,
            resultAtMs: fixture.resultAtMs,
            evaluatedAtMs: fixture.evaluatedAtMs,
            boundAtMs: fixture.evaluatedAtMs,
        });
        proofRecords.set(binding.digest, { item: binding, valid: true });
        return { id: field.id, digest: binding.digest };
    });
};
const hasValidProofs = (fixture, rule, value = targets) => {
    const contract = lookup(value.proofs, rule.proofRef);
    if (!contract || !Array.isArray(fixture.proofs)) return false;
    if (fixture.proofs.length !== contract.fields.length) return false;
    if (new Set(fixture.proofs.map((item) => item.id)).size !== fixture.proofs.length) return false;
    return contract.fields.every((required) => {
        const observed = fixture.proofs.find((item) => item.id === required.id);
        const binding = resolveAttestation(proofRecords, observed?.digest);
        const capture = binding && resolveAttestation(captureRecords, binding.captureDigest);
        return binding?.field === required.id
            && binding.eventId === fixture.eventId
            && binding.requestHmac === fixture.requestHmac
            && binding.resultTxn === fixture.resultTxn
            && binding.objective === fixture.objective
            && binding.admission === fixture.admission
            && binding.outcome === fixture.outcome
            && binding.profile === contract.id
            && binding.startAtMs === fixture.startAtMs
            && binding.resultAtMs === fixture.resultAtMs
            && binding.evaluatedAtMs === fixture.evaluatedAtMs
            && binding.boundAtMs === fixture.evaluatedAtMs
            && capture?.eventId === fixture.eventId
            && capture.requestHmac === fixture.requestHmac
            && capture.field === required.id
            && capture.claim === required.claim
            && capture.source === required.source
            && capture.phase === required.phase
            && fixture.startAtMs <= fixture.resultAtMs
            && fixture.resultAtMs <= fixture.evaluatedAtMs
            && capture.capturedAtMs <= fixture.evaluatedAtMs
            && (required.phase === 'before_start'
                ? capture.resultTxn === null
                    && capture.capturedAtMs <= fixture.startAtMs
                    && fixture.startAtMs - capture.capturedAtMs <= required.maxAgeMs
                : capture.resultTxn === fixture.resultTxn
                    && capture.capturedAtMs >= fixture.resultAtMs
                    && capture.capturedAtMs - fixture.resultAtMs <= required.maxAgeMs);
    });
};
const grade = (fixture, value = targets) => {
    const objective = lookup(value.objectives, fixture.objective);
    if (!objective) return 'invalid';
    const eligible = lookup(value.eligibility, objective.eligibilityRef);
    const result = lookup(value.results, objective.resultRef);
    if (!eligible || !result) return 'invalid';
    const admitDomain = lookup(value.domains, eligible.domain);
    const resultDomain = lookup(value.domains, result.domain);
    if (!admitDomain || !resultDomain) return 'invalid';
    if (!admitDomain.values.includes(fixture.admission)) return 'invalid';
    if (!resultDomain.values.includes(fixture.outcome)) return 'invalid';
    if (!Number.isFinite(fixture.durationMs) || fixture.durationMs < 0) return 'invalid';
    if (![fixture.startAtMs, fixture.resultAtMs, fixture.evaluatedAtMs].every(Number.isSafeInteger)
        || fixture.startAtMs < 0 || fixture.resultAtMs < fixture.startAtMs
        || fixture.evaluatedAtMs < fixture.resultAtMs
        || fixture.durationMs !== fixture.resultAtMs - fixture.startAtMs) return 'invalid';

    const pairSet = value.pairs.find((item) => item.admitDomain === admitDomain.id
        && item.resultDomain === resultDomain.id);
    const pairRule = pairSet?.rules.find((item) => item.admission === fixture.admission
        && item.outcome === fixture.outcome);
    if (pairSet && !pairRule) return 'bad';

    if (!eligible.include.includes(fixture.admission) && !eligible.exclude.includes(fixture.admission)) return 'invalid';
    if (pairRule && !hasValidProofs(fixture, pairRule, value)) return 'bad';
    if (eligible.exclude.includes(fixture.admission)) return 'excluded';
    if (pairRule?.grade === 'bad') return 'bad';

    if (objective.basis === 'ex_ante_qualified') {
        const contract = lookup(value.qualifiers, objective.qualifierRef);
        const observed = fixture.qualifier;
        if (!observed) return contract.missing;
        if (observed.phase !== contract.phase) return contract.wrongPhase;
        if (observed.ageMs > contract.maxAgeMs) return contract.stale;
        if (!contract.states.includes(observed.state) || observed.state === 'unknown') return contract.unknown;
        if (observed.state !== contract.healthy) return contract.unhealthy;
    }

    const cohort = value.cohorts.find((item) => item.objective === objective.id);
    if (cohort) {
        const state = cohortState(fixture, cohort);
        if (state === 'pending') return 'pending';
        if (state !== 'valid') return 'bad';
    }

    if (result.bad.includes(fixture.outcome)) return 'bad';
    if (!result.good.includes(fixture.outcome)) return 'invalid';
    return fixture.durationMs <= objective.thresholdMs ? 'good' : 'bad';
};

const telemetryGate = (fixture, value = targets) => {
    const objective = lookup(value.objectives, fixture.objective);
    const eligible = objective && lookup(value.eligibility, objective.eligibilityRef);
    const result = objective && lookup(value.results, objective.resultRef);
    const admitDomain = eligible && lookup(value.domains, eligible.domain);
    const resultDomain = result && lookup(value.domains, result.domain);
    if (!admitDomain?.values.includes(fixture.admission)
        || !resultDomain?.values.includes(fixture.outcome)) return null;
    const pairSet = value.pairs.find((item) => item.admitDomain === admitDomain.id
        && item.resultDomain === resultDomain.id);
    if (pairSet) {
        const rule = pairSet.rules.find((item) => item.admission === fixture.admission
            && item.outcome === fixture.outcome);
        if (!rule || !hasValidProofs(fixture, rule, value)) return 'telemetry_gap';
    }
    if (eligible.exclude.includes(fixture.admission)) return null;
    const cohort = value.cohorts.find((item) => item.objective === objective.id);
    if (cohort && cohortState(fixture, cohort) === 'bad') return cohort.gate;
    return null;
};
const evaluate = (fixture, value = targets) => ({
    grade: grade(fixture, value),
    gate: telemetryGate(fixture, value),
});

const caseNames = cases.cases.map((item) => item.name);
if (new Set(caseNames).size !== caseNames.length) throw new Error('SLO case names must be unique');
const eventIds = cases.cases.map((item) => item.eventId);
if (new Set(eventIds).size !== eventIds.length) throw new Error('SLO event IDs must be unique');
for (const fixture of cases.cases) {
    const actual = evaluate(fixture);
    const expectedGate = fixture.gate ?? null;
    if (actual.grade !== fixture.expected || actual.gate !== expectedGate) {
        throw new Error(`${fixture.name}: expected ${fixture.expected}/${expectedGate}, received ${actual.grade}/${actual.gate}`);
    }
}

let matrixSeq = 0;
const matrixCohort = (contract, fixture) => {
    const id = `matrix_cohort_${matrixSeq}`;
    const version = 'matrix_v1';
    const cohort = {
        id,
        objective: fixture.objective,
        registry: {
            keyVersion: 'fixture_v1',
            source: contract.registry,
            eventId: fixture.eventId,
            requestHmac: fixture.requestHmac,
            snapshotAtMs: fixture.startAtMs,
            version,
            watermark: true,
            rows: [],
        },
        terminal: {
            keyVersion: 'fixture_v1',
            source: contract.observer,
            registryDigest: '',
            eventId: fixture.eventId,
            requestHmac: fixture.requestHmac,
            resultTxn: fixture.resultTxn,
            startAtMs: fixture.startAtMs,
            resultAtMs: fixture.resultAtMs,
            evaluatedAtMs: fixture.evaluatedAtMs,
            finalizedAtMs: fixture.resultAtMs,
            focusKey: null,
            rows: [],
        },
    };
    if (contract.mode === 'active_minute') {
        const key = { object_hmac: `object_${matrixSeq}`, minute_start: `minute_${matrixSeq}` };
        cohort.terminal.focusKey = key;
        cohort.registry.rows.push({ key });
        cohort.terminal.rows.push({
            key,
            fields: {
                registry_version: version,
                watermark_at: fixture.startAtMs,
                sample_at: fixture.resultAtMs,
                result: fixture.outcome,
            },
        });
    } else {
        const key = {
            source_hmac: `source_${matrixSeq}`,
            event_id: fixture.eventId,
            snapshot_version: version,
            rule_hmac: `rule_${matrixSeq}`,
        };
        cohort.registry.rows.push({ key });
        const row = {
            key,
            fields: {
                snapshot_version: version,
                rule_count: 1,
                eval_count: 1,
                coverage_watermark: true,
                result: fixture.outcome,
                match_receipt: null,
            },
        };
        if (fixture.outcome === 'matched') {
            const effect = sealAttestation('effect', {
                keyVersion: 'fixture_v1',
                source: contract.effectStore,
                receiptId: `receipt_${matrixSeq}`,
                cohortId: id,
                eventId: fixture.eventId,
                requestHmac: fixture.requestHmac,
                resultTxn: fixture.resultTxn,
                ruleHmac: key.rule_hmac,
                committedAtMs: fixture.resultAtMs,
            });
            effectIndex.add(effect, true);
            row.fields.match_receipt = effect.digest;
        }
        cohort.terminal.rows.push(row);
    }
    sealCohort(cohort);
    cohortRecords.set(id, { item: cohort, valid: true });
    return id;
};
const matrixCase = (objective, admission, outcome) => {
    matrixSeq += 1;
    const startAtMs = 2_000_000_000 + matrixSeq * 100_000;
    const fixture = {
        name: `matrix ${objective.id} ${admission} ${outcome}`,
        eventId: `matrix_${matrixSeq}`,
        requestHmac: `matrix_req_${matrixSeq}`,
        resultTxn: `matrix_txn_${matrixSeq}`,
        startAtMs,
        resultAtMs: startAtMs,
        evaluatedAtMs: startAtMs + 1,
        objective: objective.id,
        admission,
        outcome,
        durationMs: 0,
    };
    if (objective.basis === 'ex_ante_qualified') {
        fixture.qualifier = { state: 'healthy', phase: 'before_start', ageMs: 0 };
    }
    const cohort = targets.cohorts.find((item) => item.objective === objective.id);
    if (cohort) fixture.cohortRef = matrixCohort(cohort, fixture);
    const eligible = lookup(targets.eligibility, objective.eligibilityRef);
    const result = lookup(targets.results, objective.resultRef);
    const pairSet = targets.pairs.find((item) => item.admitDomain === eligible.domain
        && item.resultDomain === result.domain);
    const pairRule = pairSet?.rules.find((item) => item.admission === admission && item.outcome === outcome);
    if (pairRule) fixture.proofs = observedProofs(pairRule, fixture);
    return fixture;
};
const expectedGrade = (objective, admission, outcome) => {
    const eligible = lookup(targets.eligibility, objective.eligibilityRef);
    const result = lookup(targets.results, objective.resultRef);
    const admitDomain = lookup(targets.domains, eligible.domain);
    const resultDomain = lookup(targets.domains, result.domain);
    const pairSet = targets.pairs.find((item) => item.admitDomain === admitDomain.id
        && item.resultDomain === resultDomain.id);
    const pairRule = pairSet?.rules.find((item) => item.admission === admission && item.outcome === outcome);
    if (pairSet && !pairRule) return 'bad';
    if (eligible.exclude.includes(admission)) return 'excluded';
    if (pairRule?.grade === 'bad' || result.bad.includes(outcome)) return 'bad';
    return result.good.includes(outcome) ? 'good' : 'invalid';
};
let matrixCount = 0;
for (const objective of targets.objectives) {
    const eligible = lookup(targets.eligibility, objective.eligibilityRef);
    const result = lookup(targets.results, objective.resultRef);
    const admitDomain = lookup(targets.domains, eligible.domain);
    const resultDomain = lookup(targets.domains, result.domain);
    const pairSet = targets.pairs.find((item) => item.admitDomain === admitDomain.id
        && item.resultDomain === resultDomain.id);

    for (const admission of admitDomain.values) {
        const outcome = pairSet?.rules.find((item) => item.admission === admission)?.outcome
            ?? result.good[0];
        const fixture = matrixCase(objective, admission, outcome);
        const expectedResult = expectedGrade(objective, admission, outcome);
        if (grade(fixture) !== expectedResult) {
            throw new Error(`${fixture.name}: expected ${expectedResult}, received ${grade(fixture)}`);
        }
        matrixCount += 1;
    }
    for (const outcome of resultDomain.values) {
        const admission = pairSet?.rules.find((item) => item.outcome === outcome)?.admission
            ?? eligible.include[0];
        const fixture = matrixCase(objective, admission, outcome);
        const expectedResult = expectedGrade(objective, admission, outcome);
        if (grade(fixture) !== expectedResult) {
            throw new Error(`${fixture.name}: expected ${expectedResult}, received ${grade(fixture)}`);
        }
        matrixCount += 1;
    }
    if (pairSet) {
        for (const admission of admitDomain.values) {
            const outcomes = new Set(pairSet.rules
                .filter((item) => item.admission === admission)
                .map((item) => item.outcome));
            for (const outcome of resultDomain.values.filter((item) => !outcomes.has(item))) {
                const fixture = matrixCase(objective, admission, outcome);
                const actual = evaluate(fixture);
                if (actual.grade !== 'bad' || actual.gate !== 'telemetry_gap') {
                    throw new Error(`${fixture.name}: illegal known pair did not fail closed`);
                }
                matrixCount += 1;
            }
        }
    }
}
const mutateAttestation = (fixture, fieldId, mutateCapture, mutateBinding) => {
    const reference = fixture.proofs.find((item) => item.id === fieldId);
    const binding = clone(resolveAttestation(proofRecords, reference.digest));
    const capture = clone(resolveAttestation(captureRecords, binding.captureDigest));
    mutateCapture?.(capture);
    if (mutateCapture) {
        sealAttestation('capture', capture);
        captureRecords.set(capture.digest, { item: capture, valid: true });
        binding.captureDigest = capture.digest;
    }
    mutateBinding?.(binding);
    sealAttestation('binding', binding);
    proofRecords.set(binding.digest, { item: binding, valid: true });
    reference.digest = binding.digest;
    return fixture;
};
const authCases = [
    mutateAttestation(matrixCase(lookup(targets.objectives, 'api_good'), 'admitted', 'success'), 'route_id',
        (item) => { item.eventId = 'wrong_event'; }),
    mutateAttestation(matrixCase(lookup(targets.objectives, 'api_good'), 'admitted', 'success'), 'route_id',
        (item) => { item.requestHmac = 'wrong_request'; }),
    mutateAttestation(matrixCase(lookup(targets.objectives, 'api_good'), 'admitted', 'success'), 'route_id',
        (item) => { item.resultTxn = 'future_txn'; }),
    mutateAttestation(matrixCase(lookup(targets.objectives, 'api_good'), 'admitted', 'success'), 'route_id',
        (item) => { item.field = 'wrong_field'; }),
    mutateAttestation(matrixCase(lookup(targets.objectives, 'api_good'), 'admitted', 'success'), 'route_id',
        null, (item) => { item.boundAtMs -= 1; }),
    mutateAttestation(matrixCase(lookup(targets.objectives, 'api_good'), 'admitted', 'success'), 'route_id',
        null, (item) => { item.objective = 'core_accept'; }),
    mutateAttestation(matrixCase(lookup(targets.objectives, 'api_good'), 'admitted', 'success'), 'route_id',
        null, (item) => { item.admission = 'edge_overload'; }),
    mutateAttestation(matrixCase(lookup(targets.objectives, 'api_good'), 'admitted', 'success'), 'route_id',
        null, (item) => { item.outcome = 'reject_invalid'; }),
    mutateAttestation(matrixCase(lookup(targets.objectives, 'api_good'), 'admitted', 'success'), 'route_id',
        null, (item) => { item.profile = 'api_idem'; }),
    mutateAttestation(matrixCase(lookup(targets.objectives, 'api_good'), 'admitted', 'success'), 'route_id',
        null, (item) => { item.captureDigest = 'f'.repeat(64); }),
    mutateAttestation(matrixCase(lookup(targets.objectives, 'api_good'), 'admitted', 'success'), 'route_id',
        null, (item) => { item.startAtMs += 1; }),
    mutateAttestation(matrixCase(lookup(targets.objectives, 'api_good'), 'admitted', 'success'), 'route_id',
        null, (item) => { item.resultAtMs += 1; }),
    mutateAttestation(matrixCase(lookup(targets.objectives, 'api_good'), 'admitted', 'success'), 'route_id',
        null, (item) => { item.evaluatedAtMs += 1; item.boundAtMs += 1; }),
    mutateAttestation(matrixCase(lookup(targets.objectives, 'api_good'), 'admitted', 'noop_terminal'), 'no_effect',
        (item) => { item.resultTxn = 'wrong_txn'; }),
];
for (const fixture of authCases) {
    const actual = evaluate(fixture);
    if (actual.grade !== 'bad' || actual.gate !== 'telemetry_gap') {
        throw new Error(`${fixture.name}: cross-stage attestation mutation did not fail closed`);
    }
}
matrixCount += authCases.length;
for (const cohort of targets.cohorts) {
    const objective = lookup(targets.objectives, cohort.objective);
    const eligible = lookup(targets.eligibility, objective.eligibilityRef);
    const result = lookup(targets.results, objective.resultRef);
    const complete = matrixCase(objective, eligible.include[0], result.good[0]);
    const pending = clone(complete);
    delete pending.cohortRef;
    if (grade(pending) !== 'pending' || telemetryGate(pending) !== null) {
        throw new Error(`${cohort.objective} pre-deadline missing obligation did not remain pending`);
    }
    const missing = clone(pending);
    missing.evaluatedAtMs = missing.startAtMs + cohort.finalizeSec * 1000;
    if (grade(missing) !== 'bad' || telemetryGate(missing) !== cohort.gate) {
        throw new Error(`${cohort.objective} missing obligation did not fail closed`);
    }
    const incomplete = clone(complete);
    const incompleteSet = clone(cohortRecords.get(complete.cohortRef).item);
    incompleteSet.id = `broken_cohort_${matrixSeq}`;
    incompleteSet.terminal.rows = [];
    sealCohort(incompleteSet);
    cohortRecords.set(incompleteSet.id, { item: incompleteSet, valid: true });
    incomplete.cohortRef = incompleteSet.id;
    if (grade(incomplete) !== 'bad' || telemetryGate(incomplete) !== cohort.gate) {
        throw new Error(`${cohort.objective} incomplete obligation did not fail closed`);
    }
    matrixCount += 3;
}

const orderObjective = lookup(targets.objectives, 'order_fresh');
const freshnessSibling = (outcome) => {
    const fixture = matrixCase(orderObjective, 'active', 'fresh');
    const cohort = clone(cohortRecords.get(fixture.cohortRef).item);
    cohort.id = `${outcome}_sibling_${matrixSeq}`;
    const key = { object_hmac: `${outcome}_object_${matrixSeq}`, minute_start: `${outcome}_minute_${matrixSeq}` };
    cohort.registry.rows.push({ key });
    cohort.terminal.rows.push({
        key,
        fields: {
            registry_version: cohort.registry.version,
            watermark_at: fixture.startAtMs,
            sample_at: fixture.resultAtMs,
            result: outcome,
        },
    });
    sealCohort(cohort);
    cohortRecords.set(cohort.id, { item: cohort, valid: true });
    fixture.cohortRef = cohort.id;
    return fixture;
};
for (const outcome of ['stale', 'gap', 'unknown']) {
    const focus = matrixCase(orderObjective, 'active', outcome);
    if (grade(focus) !== 'bad' || telemetryGate(focus) !== null) {
        throw new Error(`Authenticated ${outcome} focus was misclassified as corrupt telemetry`);
    }
    const sibling = freshnessSibling(outcome);
    if (grade(sibling) !== 'good' || telemetryGate(sibling) !== null) {
        throw new Error(`Authenticated ${outcome} sibling corrupted a fresh focus sample`);
    }
}

const alertObjective = lookup(targets.objectives, 'alert_match');
const effectMismatch = (label, change) => {
    const fixture = matrixCase(alertObjective, 'supported', 'matched');
    const cohort = clone(cohortRecords.get(fixture.cohortRef).item);
    cohort.id = `effect_${label}_${matrixSeq}`;
    fixture.cohortRef = cohort.id;
    const row = cohort.terminal.rows[0];
    const original = resolveAttestation(effectRecords, row.fields.match_receipt);
    const effect = clone(original);
    effect.receiptId = `receipt_${label}_${matrixSeq}`;
    effect.cohortId = cohort.id;
    change(effect, fixture);
    sealAttestation('effect', effect);
    effectIndex.add(effect, true);
    row.fields.match_receipt = effect.digest;
    sealCohort(cohort);
    cohortRecords.set(cohort.id, { item: cohort, valid: true });
    return fixture;
};
for (const fixture of [
    effectMismatch('event', (effect) => { effect.eventId = 'wrong_event'; }),
    effectMismatch('request', (effect) => { effect.requestHmac = 'wrong_request'; }),
    effectMismatch('txn', (effect) => { effect.resultTxn = 'wrong_txn'; }),
    effectMismatch('early', (effect, fixture) => { effect.committedAtMs = fixture.startAtMs - 1; }),
    effectMismatch('late', (effect, fixture) => { effect.committedAtMs = fixture.resultAtMs + 1; }),
]) {
    if (grade(fixture) !== 'bad' || telemetryGate(fixture) !== 'telemetry_gap') {
        throw new Error(`${fixture.cohortRef} effect identity mutation did not fail closed`);
    }
}

const receiptCollision = (reverse) => {
    const fixture = matrixCase(alertObjective, 'supported', 'matched');
    const cohort = clone(cohortRecords.get(fixture.cohortRef).item);
    cohort.id = `receipt_collision_${reverse ? 'reverse' : 'forward'}_${matrixSeq}`;
    fixture.cohortRef = cohort.id;
    const version = cohort.registry.version;
    const firstRow = cohort.terminal.rows[0];
    const secondKey = { ...firstRow.key, rule_hmac: `${firstRow.key.rule_hmac}_second` };
    cohort.registry.rows.push({ key: secondKey });
    cohort.terminal.rows.push({
        key: secondKey,
        fields: { ...firstRow.fields },
    });
    for (const row of cohort.terminal.rows) {
        row.fields.rule_count = 2;
        row.fields.eval_count = 2;
        row.fields.snapshot_version = version;
    }
    const receiptId = `receipt_collision_${reverse ? 'reverse' : 'forward'}_${matrixSeq}`;
    const effects = cohort.terminal.rows.map((row) => sealAttestation('effect', {
        keyVersion: 'fixture_v1',
        source: 'alert_effect_store',
        receiptId,
        cohortId: cohort.id,
        eventId: fixture.eventId,
        requestHmac: fixture.requestHmac,
        resultTxn: fixture.resultTxn,
        ruleHmac: row.key.rule_hmac,
        committedAtMs: fixture.resultAtMs,
    }));
    const ordered = reverse ? [...effects].reverse() : effects;
    for (const effect of ordered) effectIndex.add(effect, true);
    for (let index = 0; index < effects.length; index += 1) {
        cohort.terminal.rows[index].fields.match_receipt = effects[index].digest;
    }
    sealCohort(cohort);
    cohortRecords.set(cohort.id, { item: cohort, valid: true });
    return fixture;
};
for (const reverse of [false, true]) {
    const fixture = receiptCollision(reverse);
    if (grade(fixture) !== 'bad' || telemetryGate(fixture) !== 'telemetry_gap') {
        throw new Error('Duplicate durable receipt identity graded good');
    }
}

const crossCohortCollision = (reverse) => {
    const fixtures = [
        matrixCase(alertObjective, 'supported', 'matched'),
        matrixCase(alertObjective, 'supported', 'matched'),
    ];
    const receiptId = `cross_cohort_receipt_${reverse ? 'reverse' : 'forward'}_${matrixSeq}`;
    const records = fixtures.map((fixture, index) => {
        const cohort = clone(cohortRecords.get(fixture.cohortRef).item);
        cohort.id = `cross_cohort_${reverse ? 'reverse' : 'forward'}_${matrixSeq}_${index}`;
        fixture.cohortRef = cohort.id;
        const row = cohort.terminal.rows[0];
        const original = resolveAttestation(effectRecords, row.fields.match_receipt);
        const effect = sealAttestation('effect', {
            ...clone(original),
            receiptId,
            cohortId: cohort.id,
        });
        row.fields.match_receipt = effect.digest;
        sealCohort(cohort);
        cohortRecords.set(cohort.id, { item: cohort, valid: true });
        return effect;
    });
    for (const effect of reverse ? [...records].reverse() : records) effectIndex.add(effect, true);
    return fixtures;
};
for (const reverse of [false, true]) {
    for (const fixture of crossCohortCollision(reverse)) {
        if (grade(fixture) !== 'bad' || telemetryGate(fixture) !== 'telemetry_gap') {
            throw new Error('Cross-cohort durable receipt identity graded good');
        }
    }
}

const zeroFixture = cases.cases.find((item) => item.cohortRef === 'alert_zero_good');
const zeroCohort = cases.cohorts.find((item) => item.id === zeroFixture?.cohortRef);
if (!zeroFixture || !zeroCohort || zeroCohort.registry.rows.length !== 0) {
    throw new Error('Authenticated empty cohort fixture is missing');
}
for (const [label, change] of [
    ['request', (cohort) => {
        cohort.registry.requestHmac = 'wrong_request';
        cohort.terminal.requestHmac = 'wrong_request';
    }],
    ['objective', (cohort) => { cohort.objective = 'order_fresh'; }],
    ['snapshot', (cohort) => { cohort.registry.snapshotAtMs += 1; }],
]) {
    const fixture = clone(zeroFixture);
    const cohort = clone(zeroCohort);
    cohort.id = `zero_${label}_${matrixSeq}`;
    change(cohort);
    sealCohort(cohort);
    cohortRecords.set(cohort.id, { item: cohort, valid: true });
    fixture.cohortRef = cohort.id;
    const actual = evaluate(fixture);
    if (actual.grade !== 'bad' || actual.gate !== 'telemetry_gap') {
        throw new Error(`Empty cohort ${label} substitution did not fail closed`);
    }
}
matrixCount += 20;

const invalidExcluded = matrixCase(lookup(targets.objectives, 'api_good'), 'bad_syntax', 'not_a_result');
if (grade(invalidExcluded) !== 'invalid') throw new Error('Excluded API event hid an invalid outcome');
const invalidQualified = matrixCase(lookup(targets.objectives, 'action_resolve'), 'durable', 'not_a_result');
invalidQualified.qualifier.state = 'unhealthy';
if (grade(invalidQualified) !== 'invalid') throw new Error('Unhealthy qualifier hid an invalid outcome');
matrixCount += 2;
const coverageErrors = (fixtures) => {
    const errors = [];
    for (const objective of targets.objectives) {
        const covered = fixtures.filter((item) => item.objective === objective.id);
        const eligible = lookup(targets.eligibility, objective.eligibilityRef);
        const result = lookup(targets.results, objective.resultRef);
        const included = (item) => eligible.include.includes(item.admission);
        const goodResult = (item) => result.good.includes(item.outcome);
        const badResult = (item) => result.bad.includes(item.outcome);
        if (!covered.some((item) => included(item) && goodResult(item)
            && item.durationMs === objective.thresholdMs && item.expected === 'good')) {
            errors.push(`${objective.id} lacks an exact-threshold good case`);
        }
        if (!covered.some((item) => included(item) && goodResult(item)
            && item.durationMs === objective.thresholdMs + 1 && item.expected === 'bad')) {
            errors.push(`${objective.id} lacks a threshold-plus-one bad case`);
        }
        if (!covered.some((item) => included(item) && badResult(item)
            && item.durationMs <= objective.thresholdMs && item.expected === 'bad')) {
            errors.push(`${objective.id} lacks a fast bad-result case`);
        }
    }
    return errors;
};
const fixtureCoverage = coverageErrors(cases.cases);
if (fixtureCoverage.length > 0) throw new Error(fixtureCoverage.join('\n'));
for (const objective of targets.objectives.filter((item) => item.class === 'diagnostic')) {
    const covered = cases.cases.filter((item) => item.objective === objective.id);
    const requiredGrades = [
        ['good', (item) => item.qualifier?.state === 'healthy'],
        ['bad', (item) => item.qualifier?.state === 'healthy'],
        ['excluded', (item) => item.qualifier?.state === 'unhealthy'],
        ['qualification_fault', (item) => !item.qualifier],
        ['qualification_fault', (item) => item.qualifier?.state === 'unknown'],
        ['qualification_fault', (item) => item.qualifier?.phase === 'after_result'],
        ['qualification_fault', (item) => item.qualifier?.ageMs > 5000],
    ];
    for (const [gradeName, predicate] of requiredGrades) {
        if (!covered.some((item) => item.expected === gradeName && predicate(item))) {
            throw new Error(`${objective.id} lacks diagnostic truth coverage for ${gradeName}`);
        }
    }
}

const mutate = (id, collection, change) => {
    const value = clone(targets);
    const item = value[collection].find((candidate) => candidate.id === id);
    if (!item) throw new Error(`Invalid test references missing ${collection}.${id}`);
    change(item, value);
    return value;
};
const invalidCases = [
    ['unknown root field', () => ({ ...clone(targets), promise: 'millions' })],
    ['old contract version', () => ({ ...clone(targets), schema: 5 })],
    ['future contract version', () => ({ ...clone(targets), schema: 7 })],
    ['100 percent ratio', () => mutate('api_good', 'objectives', (item) => { item.target = 1; })],
    ['incomplete eligibility', () => mutate('api_eligible', 'eligibility', (item) => { item.exclude.pop(); })],
    ['overlapping eligibility', () => mutate('api_eligible', 'eligibility', (item) => { item.exclude.push('admitted'); })],
    ['incomplete result', () => mutate('api_success', 'results', (item) => { item.bad.pop(); })],
    ['result overlap', () => mutate('api_success', 'results', (item) => { item.bad.push('success'); })],
    ['overload graded good', () => mutate('api_success', 'results', (item) => {
        item.bad = item.bad.filter((value) => value !== 'overload');
        item.good.push('overload');
    })],
    ['generic safe rejection', () => {
        const value = clone(targets);
        value.domains.find((item) => item.id === 'api_result').values.push('safe_reject');
        value.results.find((item) => item.id === 'api_success').good.push('safe_reject');
        return value;
    }],
    ['edge overload result grading', () => mutate('api_pairs', 'pairs', (item) => {
        item.rules.find((rule) => rule.admission === 'edge_overload').grade = 'result';
    })],
    ['quota proof removed', () => mutate('quota_reject', 'proofs', (item) => { item.fields.pop(); })],
    ['quota proof claim changed', () => mutate('quota_reject', 'proofs', (item) => { item.fields[0].claim = 'quota_available'; })],
    ['quota proof phase changed', () => mutate('quota_reject', 'proofs', (item) => { item.fields[0].phase = 'after_result'; })],
    ['quota graded good', () => {
        const value = clone(targets);
        value.pairs[0].rules.find((rule) => rule.admission === 'over_quota').grade = 'result';
        const result = value.results.find((item) => item.id === 'api_success');
        result.bad = result.bad.filter((item) => item !== 'reject_quota');
        result.good.push('reject_quota');
        return value;
    }],
    ['unknown pair proof', () => mutate('api_pairs', 'pairs', (item) => { item.rules[0].proofRef = 'missing_proof'; })],
    ['invalid API pair added', () => mutate('api_pairs', 'pairs', (item) => {
        item.rules.find((rule) => rule.admission === 'edge_overload').outcome = 'success';
    })],
    ['expired intent admitted', () => mutate('intent_eligible', 'eligibility', (item) => {
        item.exclude = item.exclude.filter((value) => value !== 'expired_at_entry');
        item.include.push('expired_at_entry');
    })],
    ['result-derived qualifier', () => mutate('provider_chain', 'qualifiers', (item) => { item.phase = 'after_result'; })],
    ['unknown qualifier healthy', () => mutate('provider_chain', 'qualifiers', (item) => { item.healthy = 'unknown'; })],
    ['missing qualifier excluded', () => mutate('provider_chain', 'qualifiers', (item) => { item.missing = 'excluded'; })],
    ['missing qualifier ref', () => mutate('action_resolve', 'objectives', (item) => { item.qualifierRef = null; })],
    ['component error budget', () => mutate('quote_overhead', 'objectives', (item) => { item.budget = true; })],
    ['qualified user journey', () => mutate('api_good', 'objectives', (item) => { item.basis = 'ex_ante_qualified'; item.qualifierRef = 'provider_chain'; })],
    ['minute latency measure', () => mutate('market_fresh', 'objectives', (item) => { item.measure = 'elapsed'; })],
    ['result-time API start', () => mutate('api_good', 'objectives', (item) => { item.start = 'result_started_at'; })],
    ['API stage classifier', () => mutate('api_good', 'objectives', (item) => { item.resultRef = 'stage_success'; })],
    ['success-only intent stop', () => mutate('core_accept', 'objectives', (item) => { item.stop = 'intent_committed_at'; })],
    ['order poll freshness', () => mutate('order_fresh', 'objectives', (item) => { item.start = 'last_order_sync_at'; })],
    ['market last-trade freshness', () => mutate('market_fresh', 'objectives', (item) => { item.start = 'last_trade_at'; })],
    ['matched-only alert stop', () => mutate('alert_match', 'objectives', (item) => { item.stop = 'alert_event_at'; })],
    ['wallet threshold weakened', () => mutate('wallet_project', 'objectives', (item) => { item.thresholdMs = 20000; })],
    ['wallet target weakened', () => mutate('wallet_project', 'objectives', (item) => { item.target = 0.98; })],
    ['wallet eligibility swapped', () => mutate('wallet_project', 'objectives', (item) => { item.eligibilityRef = 'minute_eligible'; })],
    ['orphan slice policy', () => mutate('order_accept', 'objectives', (item) => { item.slicePolicy = null; })],
    ['unknown slice', () => mutate('order_accept', 'objectives', (item) => { item.sliceRef = 'missing_slice'; })],
    ['matcher registry changed', () => {
        const value = clone(targets);
        value.cohorts[0].registry = 'matcher_output';
        return value;
    }],
    ['matcher observer changed', () => {
        const value = clone(targets);
        value.cohorts[0].observer = 'matcher_output';
        return value;
    }],
    ['matcher effect proof removed', () => {
        const value = clone(targets);
        value.cohorts[0].effectField = null;
        return value;
    }],
    ['matcher effect store changed', () => {
        const value = clone(targets);
        value.cohorts[0].effectStore = 'matcher_output';
        return value;
    }],
    ['matcher focus weakened', () => {
        const value = clone(targets);
        value.cohorts[0].focus = 'one_key';
        return value;
    }],
    ['cohort deadline origin changed', () => {
        const value = clone(targets);
        value.cohorts[0].deadlineFrom = 'result_time';
        return value;
    }],
    ['matcher count proof weakened', () => {
        const value = clone(targets);
        value.cohorts[0].complete = 'one_per_active';
        return value;
    }],
    ['freshness registry omitted', () => {
        const value = clone(targets);
        value.cohorts.pop();
        return value;
    }],
    ['positive correctness tolerance', () => mutate('duplicate_effect', 'gates', (item) => { item.limit = 1; })],
    ['gate event changed', () => mutate('duplicate_effect', 'gates', (item) => { item.event = 'lost_intent'; })],
    ['gate metric changed', () => mutate('duplicate_effect', 'gates', (item) => { item.metric = 'fervor_order_lost_total'; })],
    ['gate scope changed', () => mutate('duplicate_effect', 'gates', (item) => { item.scope = 'order'; })],
    ['gate without page', () => mutate('duplicate_effect', 'gates', (item) => { item.actions = item.actions.filter((action) => action !== 'page'); })],
    ['global gate without freeze', () => mutate('secret_leak', 'gates', (item) => { item.actions = ['page', 'block_release', 'degrade_scope']; })],
    ['weakened gate proof', () => mutate('telemetry_gap', 'gates', (item) => { item.rearm.proofs.pop(); })],
    ['different regional data loss', () => mutate('core_region_write', 'recovery', (item) => { item.dataRpo.targetSec = 121; })],
    ['replica-survivor loss scope', () => mutate('core_az', 'recovery', (item) => { item.dataRpo.lossScope = 'all_committed_events'; })],
    ['weak regional resume', () => mutate('core_region_write', 'recovery', (item) => { item.proofs.pop(); })],
    ['late RTO start', () => mutate('core_az', 'recovery', (item) => { item.rto.start = 'fault_detected_at'; })],
    ['missing market replay proof', () => mutate('market_restore', 'recovery', (item) => { item.proofs.pop(); })],
    ['forbidden metric label', () => {
        const value = clone(targets);
        value.telemetry.instruments[0].labels.push({ name: 'service', maxValues: 8, source: 'fixed' });
        return value;
    }],
    ['series undercount', () => {
        const value = clone(targets);
        value.telemetry.instruments[0].maxSeries -= 1;
        return value;
    }],
    ['asserted histogram factor', () => {
        const value = clone(targets);
        value.telemetry.instruments[1].seriesFactor = 1;
        value.telemetry.instruments[1].maxSeries = 1932;
        return value;
    }],
    ['descending histogram buckets', () => {
        const value = clone(targets);
        [value.telemetry.instruments[1].bucketsSec[2], value.telemetry.instruments[1].bucketsSec[3]]
            = [value.telemetry.instruments[1].bucketsSec[3], value.telemetry.instruments[1].bucketsSec[2]];
        return value;
    }],
    ['global series undercount', () => { const value = clone(targets); value.telemetry.maxSeries = 1; return value; }],
    ['telemetry grade removed', () => { const value = clone(targets); value.telemetry.grades.pop(); return value; }],
    ['burn rate changed', () => { const value = clone(targets); value.burn[0].rate = 14.5; return value; }],
    ['changed no-data policy', () => mutate('api_good', 'objectives', (item) => { item.noData = 'pass'; })],
    ['missing qualification profile', () => { const value = clone(targets); value.qualification.profiles.pop(); return value; }],
    ['missing qualification report', () => { const value = clone(targets); value.qualification.reports.pop(); return value; }],
    ['partial canary ladder', () => { const value = clone(targets); value.qualification.canary.stagesPct.pop(); return value; }],
    ['descending canary ladder', () => { const value = clone(targets); value.qualification.canary.stagesPct = [1, 25, 5, 50, 95]; return value; }],
    ['matched control at full rollout', () => { const value = clone(targets); value.qualification.canary.stagesPct = [1, 5, 25, 50, 100]; return value; }],
];
for (const [name, create] of invalidCases) {
    if (accepts(create())) throw new Error(`Unsafe SLO case was accepted: ${name}`);
}
const mutateLeaf = (root, path, change) => {
    let cursor = root;
    for (const key of path.slice(0, -1)) cursor = cursor[key];
    cursor[path.at(-1)] = change(cursor[path.at(-1)]);
};
const qualificationLeaves = [];
const collectLeaves = (value, path = []) => {
    if (value !== null && typeof value === 'object') {
        for (const [key, child] of Object.entries(value)) collectLeaves(child, [...path, key]);
        return;
    }
    qualificationLeaves.push(path);
};
collectLeaves(targets.qualification);
for (const path of qualificationLeaves) {
    const value = clone(targets);
    mutateLeaf(value.qualification, path, (item) => {
        if (typeof item === 'number') return item + 1;
        if (typeof item === 'boolean') return !item;
        return `${item}_changed`;
    });
    if (accepts(value)) throw new Error(`Qualification leaf failed open: ${path.join('.')}`);
}
const fiveRegionErrors = semanticErrors(targets, 5);
if (!fiveRegionErrors.some((item) => item.includes('exceeds the global limit'))) {
    throw new Error('Five-region deployment bypassed telemetry budget checks');
}

const canonicalHash = '1e8267c9c42eb05c925db81007ac3b4345bbf97c75571bcdb864d341d04e3240';
const actualHash = createHash('sha256').update(JSON.stringify(targets)).digest('hex');
if (actualHash !== canonicalHash) throw new Error(`Canonical SLO target changed: ${actualHash}`);
const fixtureHash = '4b46a360fc20a1512bf50cadc6dbd5f836ecae96499fb06891ca64445e058631';
const actualFixtureHash = createHash('sha256').update(JSON.stringify(cases)).digest('hex');
if (actualFixtureHash !== fixtureHash) throw new Error(`Canonical SLO fixtures changed: ${actualFixtureHash}`);

const pct = (value) => `${Number((value * 100).toFixed(4))}%`;
const code = (value) => `\`${value}\``;
const list = (values) => values.map(code).join(', ');
const table = (headings, rows) => [
    `| ${headings.join(' | ')} |`,
    `| ${headings.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.join(' | ')} |`),
].join('\n');
const seriesFactor = (item) => (item.kind === 'histogram' ? item.bucketsSec.length + 3 : 1);
const generated = {
    eligibility: table(['Classifier', 'Domain', 'Included', 'Excluded'], targets.eligibility.map((item) => [code(item.id), code(item.domain), list(item.include), list(item.exclude)])),
    objectives: table(['ID', 'Class / basis', 'Boundary', 'Good', 'Target', 'Budget', 'Slice'], targets.objectives.map((item) => [
        code(item.id),
        `${item.class} / ${code(item.basis)}`,
        `${code(item.start)} → ${code(item.stop)}`,
        `${code(item.resultRef)} at most ${item.thresholdMs.toLocaleString('en-US')} ms (${item.measure})`,
        pct(item.target),
        item.budget ? 'yes' : 'no',
        item.sliceRef ? `${code(item.sliceRef)}: each` : 'none',
    ])),
    gates: table(['ID', 'Scope', 'Actions', 'Rearm'], targets.gates.map((item) => [
        code(item.id),
        code(item.scope),
        list(item.actions),
        `${list(item.rearm.proofs)}; ack ${list(item.rearm.ackRoles)}; ${code(item.rearm.baseline)}`,
    ])),
    recovery: table(['ID', 'Store / fault', 'Detect', 'Data RPO', 'Restore', 'Resume proof'], targets.recovery.map((item) => [
        code(item.id),
        `${code(item.store)} / ${code(item.fault)}`,
        `at most ${item.detectSec} s`,
        `${item.dataRpo.targetSec} s target / ${item.dataRpo.maxSec} s max (${item.dataRpo.bound}; ${item.dataRpo.lossScope}; ${item.dataRpo.ackGuard})`,
        `at most ${item.rto.targetSec} s from ${code(item.rto.start)} to ${code(item.rto.stop)}`,
        `${code(item.resume)}: ${list(item.proofs)}`,
    ])),
    telemetry: table(['Instrument', 'Labels', 'Factor', 'Max series'], targets.telemetry.instruments.map((item) => [code(item.metric), item.labels.map((label) => `${code(label.name)}≤${label.maxValues}`).join(', '), String(seriesFactor(item)), item.maxSeries.toLocaleString('en-US')])),
    burn: table(['Severity', 'Long', 'Short', 'Burn rate'], targets.burn.map((item) => [item.severity, code(item.long), code(item.short), String(item.rate)])),
};
if (process.argv.includes('--print-generated')) {
    for (const [name, content] of Object.entries(generated)) {
        console.log(`<!-- generated:${name}:start -->\n${content}\n<!-- generated:${name}:end -->\n`);
    }
    process.exit(0);
}
const forbiddenCopy = [
    ['backend/src/services/discordBotService.ts', /professional[- ]grade/i],
    ['backend/src/services/discordBotService.ts', /enterprise[- ](?:grade|level)(?: security)?/i],
    ['backend/src/services/discordBotService.ts', /(?:99\.9%|24\s*\/\s*7) uptime/i],
    ['backend/src/services/discordBotService.ts', /professional support/i],
];
for (const [file, pattern] of forbiddenCopy) {
    if (pattern.test(read(resolveRoot(file)))) throw new Error(`${file} retains unsubstantiated copy: ${pattern}`);
}

console.log(`slo spec: ${targets.objectives.length} objectives, ${cases.cases.length} truth cases, ${matrixCount} matrix cases, ${invalidCases.length + qualificationLeaves.length + 1} negative cases, ${targets.telemetry.instruments.reduce((sum, item) => sum + item.maxSeries, 0)} max series`);
