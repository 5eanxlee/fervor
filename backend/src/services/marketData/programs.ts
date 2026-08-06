export interface SolanaProgramTarget {
    id: string;
    label: string;
    protocol: string;
    category: 'launchpad' | 'amm' | 'clmm' | 'dlmm' | 'bonding_curve';
}

export const SOLANA_PROGRAM_TARGETS: SolanaProgramTarget[] = [
    {
        id: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
        label: 'Pump.fun bonding curve',
        protocol: 'pump_fun',
        category: 'bonding_curve',
    },
    {
        id: 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA',
        label: 'PumpSwap AMM',
        protocol: 'pump_swap',
        category: 'amm',
    },
    {
        id: '675kPX9MHTjS2zt1qfr1NYJSCfn6wUCwBK6n2UZMfw',
        label: 'Raydium AMM v4',
        protocol: 'raydium_amm_v4',
        category: 'amm',
    },
    {
        id: 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK',
        label: 'Raydium CLMM',
        protocol: 'raydium_clmm',
        category: 'clmm',
    },
    {
        id: 'CPMMoo8L3F4NbTegBCKVNio1bsBk5wWK8Mwq1qkMzoC',
        label: 'Raydium CPMM',
        protocol: 'raydium_cpmm',
        category: 'amm',
    },
    {
        id: 'LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj',
        label: 'Raydium LaunchLab',
        protocol: 'raydium_launchlab',
        category: 'launchpad',
    },
    {
        id: 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo',
        label: 'Meteora DLMM',
        protocol: 'meteora_dlmm',
        category: 'dlmm',
    },
    {
        id: 'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN',
        label: 'Meteora DBC',
        protocol: 'meteora_dbc',
        category: 'bonding_curve',
    },
    {
        id: 'whirLbMiicVdio4qvUfM5KAg6CtVciGkn7hKfLiE6iQ',
        label: 'Orca Whirlpools',
        protocol: 'orca_whirlpool',
        category: 'clmm',
    },
];

export const DEFAULT_PROGRAM_IDS = SOLANA_PROGRAM_TARGETS.map((program) => program.id);
