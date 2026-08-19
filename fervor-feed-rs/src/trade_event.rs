use crate::{
    fervor_tx::{Commitment, FervorTx, Network},
    market_decoder::{DecodedSwap, QuoteKind, Side, Venue},
    pump::SupplyEvidence,
};
use serde::Serialize;
use sha2::{Digest, Sha256};

pub const TRADE_CONTRACT: &str = "fervor-trade-v1";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TradeEvent<'a> {
    pub source: &'a str,
    pub source_event_id: String,
    pub kind: &'static str,
    pub idempotency_key: String,
    pub token_mint: &'a str,
    pub quote_mint: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pool_address: Option<&'a str>,
    pub protocol: Venue,
    pub program_id: &'a str,
    pub maker: &'a str,
    pub side: Side,
    pub token_amount: f64,
    pub quote_amount: f64,
    pub token_amount_raw: &'a str,
    pub quote_amount_raw: &'a str,
    pub token_decimals: u32,
    pub quote_decimals: u32,
    pub price_quote: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sol_amount: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usd_amount: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub price_sol: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub price_usd: Option<f64>,
    pub quote_kind: QuoteKind,
    pub route: &'a [Venue],
    pub instruction_index: u32,
    pub event_index: u32,
    pub slot: u64,
    pub signature: &'a str,
    pub received_at: &'a str,
    pub observed_at: &'a str,
    pub confidence: f64,
    pub stale: bool,
    pub commitment: Commitment,
    pub decode_version: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub compute_units: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub supply: Option<SupplyEvidence>,
}

impl<'a> TradeEvent<'a> {
    pub fn from_swap(
        swap: &'a DecodedSwap,
        tx: &'a FervorTx,
        received_at: &'a str,
        supply: Option<SupplyEvidence>,
    ) -> Result<Self, String> {
        if swap.signature != tx.signed_id.signature || swap.slot != tx.occurrence.slot {
            return Err("decoded swap identity differs from its transaction".to_string());
        }
        if supply.as_ref().is_some_and(|value| {
            value.contract != crate::pump::SUPPLY_CONTRACT
                || !value.fixed
                || value.token_mint != swap.token_mint
                || value.source != tx.observation.provider
                || value.slot != swap.slot
                || value.signature != swap.signature
                || value.observed_at != tx.observed_at
                || value.commitment != tx.commitment
        }) {
            return Err("supply provenance differs from its trade".to_string());
        }
        let network = tx.signed_id.network;
        Ok(Self {
            source: &tx.observation.provider,
            source_event_id: format!(
                "{}:{}:{}:{}:{}:{}",
                tx.observation.provider,
                network.as_str(),
                swap.slot,
                swap.signature,
                swap.instruction_index,
                swap.event_index
            ),
            kind: "trade",
            idempotency_key: event_key(
                network,
                &swap.signature,
                swap.instruction_index,
                swap.event_index,
            ),
            token_mint: &swap.token_mint,
            quote_mint: &swap.quote_mint,
            pool_address: swap.pool_address.as_deref(),
            protocol: swap.protocol,
            program_id: &swap.program_id,
            maker: &swap.trader,
            side: swap.side,
            token_amount: swap.token_amount,
            quote_amount: swap.quote_amount,
            token_amount_raw: &swap.token_amount_raw,
            quote_amount_raw: &swap.quote_amount_raw,
            token_decimals: swap.token_decimals,
            quote_decimals: swap.quote_decimals,
            price_quote: swap.price_quote,
            sol_amount: swap.sol_amount,
            usd_amount: swap.usd_amount,
            price_sol: swap.price_sol,
            price_usd: swap.price_usd,
            quote_kind: swap.quote_kind,
            route: &swap.route,
            instruction_index: swap.instruction_index,
            event_index: swap.event_index,
            slot: swap.slot,
            signature: &swap.signature,
            received_at,
            observed_at: &tx.observed_at,
            confidence: swap.confidence,
            stale: false,
            commitment: tx.commitment,
            decode_version: swap.decode_version,
            compute_units: swap.compute_units,
            supply,
        })
    }
}

pub fn event_key(
    network: Network,
    signature: &str,
    instruction_index: u32,
    event_index: u32,
) -> String {
    let mut hasher = Sha256::new();
    hasher.update(format!(
        "{}:{signature}:{instruction_index}:{event_index}",
        network.as_str()
    ));
    hex::encode(hasher.finalize())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_the_shared_backend_contract() {
        let signature = "BUguQsv2ZuHus54HAFzjdJHzZBkygAjKhEeYwSG19tUfUyvvz3worsdQCdAXDNjakJHioSiyxhFiDJrm8XpSXRA";
        let mint = "YMN9Qj5jPNp7j14VPcML1B6xGgcPWVZUGLFU3Mnyfaf";
        let swap = DecodedSwap {
            signature: signature.to_string(),
            slot: 42,
            instruction_index: 0,
            event_index: 0,
            trader: "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi".to_string(),
            token_mint: mint.to_string(),
            quote_mint: "So11111111111111111111111111111111111111112".to_string(),
            token_amount: 2.0,
            quote_amount: 4.0,
            token_amount_raw: "2000000".to_string(),
            quote_amount_raw: "4000000000".to_string(),
            token_decimals: 6,
            quote_decimals: 9,
            side: Side::Buy,
            price_quote: 2.0,
            sol_amount: Some(4.0),
            usd_amount: None,
            price_sol: Some(2.0),
            price_usd: None,
            protocol: Venue::PumpFun,
            program_id: Venue::PumpFun.program_id().to_string(),
            pool_address: Some("CktRuQ2mttgRGkXJtyksdKHjUdc2C4TgDzyB98oEzy8".to_string()),
            route: vec![Venue::PumpFun],
            quote_kind: QuoteKind::Wsol,
            confidence: 0.94,
            decode_version: "balance-delta-v1",
            compute_units: Some(88_000),
        };
        let mut supply = SupplyEvidence {
            contract: crate::pump::SUPPLY_CONTRACT.to_string(),
            token_mint: mint.to_string(),
            raw_amount: "1000000000000000".to_string(),
            decimals: 6,
            fixed: true,
            layout: crate::pump::PUMP_LAYOUT.to_string(),
            source: "helius_laserstream".to_string(),
            source_event_id: format!("helius_laserstream:supply:42:{signature}:0:0"),
            slot: 42,
            signature: signature.to_string(),
            instruction_index: 0,
            event_index: 0,
            observed_at: "2024-11-19T00:00:00Z".to_string(),
            confidence: 1.0,
            stale: false,
            commitment: Commitment::Confirmed,
        };
        let mut tx: FervorTx =
            serde_json::from_str(include_str!("../../tests/contracts/fervor-tx-v1.json")).unwrap();
        tx.signed_id.network = Network::MainnetBeta;
        tx.signed_id.signature = signature.to_string();
        tx.occurrence.slot = 42;
        tx.observation.provider = "helius_laserstream".to_string();
        tx.observed_at = "2024-11-19T00:00:00Z".to_string();
        tx.commitment = Commitment::Confirmed;
        let trade = TradeEvent::from_swap(&swap, &tx, "2024-11-19T00:00:00Z", Some(supply.clone()))
            .unwrap();
        let expected: serde_json::Value =
            serde_json::from_str(include_str!("../../tests/contracts/decoded-trade-v1.json"))
                .unwrap();
        assert_eq!(serde_json::to_value(trade).unwrap(), expected);

        tx.occurrence.slot = 43;
        assert_eq!(
            TradeEvent::from_swap(&swap, &tx, &tx.observed_at, None)
                .err()
                .as_deref(),
            Some("decoded swap identity differs from its transaction")
        );
        tx.occurrence.slot = 42;
        supply.source = "another_source".to_string();
        assert_eq!(
            TradeEvent::from_swap(&swap, &tx, &tx.observed_at, Some(supply))
                .err()
                .as_deref(),
            Some("supply provenance differs from its trade")
        );
    }
}
