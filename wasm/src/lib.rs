mod codon_table;
mod constraints;
mod scrambler;

use std::collections::HashMap;

use rand::rngs::SmallRng;
use rand::SeedableRng;
use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;

use scrambler::{fast_scramble, scramble, ScramblerConfig, ScramblerResult};

// ---------------------------------------------------------------------------
// JSON types mirroring the Python API
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct Region {
    name: String,
    #[serde(rename = "type")]
    region_type: String,
    start: usize,
    end: usize,
}

#[derive(Serialize)]
struct RegionResult {
    name: String,
    #[serde(rename = "type")]
    region_type: String,
    start: usize,
    end: usize,
    aa: String,
    dna: String,
}

#[derive(Serialize)]
struct ScrambleResponse {
    dna: String,
    regions: Vec<RegionResult>,
    objective: f64,
    status: String,
}

#[derive(Serialize)]
struct SwapPartResponse {
    dna: String,
    swapped_dna: String,
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn random_seed() -> u64 {
    let mut bytes = [0u8; 8];
    getrandom::getrandom(&mut bytes).unwrap_or(());
    u64::from_le_bytes(bytes)
}

fn make_config(val: Option<&serde_json::Value>) -> ScramblerConfig {
    let mut cfg = ScramblerConfig::default();
    let Some(v) = val else { return cfg };

    if let Some(k) = v.get("k").and_then(|x| x.as_u64()) {
        cfg.k = k as usize;
    }
    if let Some(sites) = v.get("forbidden_sites").and_then(|x| x.as_array()) {
        cfg.forbidden_sites = sites
            .iter()
            .filter_map(|s| s.as_str().map(|s| s.to_uppercase()))
            .collect();
    }
    if let Some(fh) = v.get("forbidden_homopolymers").and_then(|x| x.as_bool()) {
        cfg.forbidden_homopolymers = fh;
    }
    if let Some(min) = v.get("subseq_min_len").and_then(|x| x.as_u64()) {
        cfg.subseq_min_len = min as usize;
    }
    if let Some(max) = v.get("subseq_max_len").and_then(|x| x.as_u64()) {
        cfg.subseq_max_len = max as usize;
    }
    cfg
}

fn default_encode(aa_seq: &str) -> String {
    aa_seq
        .chars()
        .map(|aa| {
            codon_table::codons_for(aa)
                .and_then(|c| c.first())
                .copied()
                .unwrap_or("NNN")
        })
        .collect()
}

fn run_scrambler(
    protein: &str,
    cfg: &ScramblerConfig,
    fast: bool,
    rng: &mut SmallRng,
) -> Result<ScramblerResult, String> {
    if fast {
        fast_scramble(protein, rng)
    } else {
        scramble(protein, cfg, rng)
    }
}

// ---------------------------------------------------------------------------
// WASM exports
// ---------------------------------------------------------------------------

#[wasm_bindgen(start)]
pub fn init_panic_hook() {
    console_error_panic_hook::set_once();
}

/// Mirrors POST /api/scramble.
/// `req_json`: JSON-encoded ScrambleRequest (with optional `fast: bool` field).
#[wasm_bindgen]
pub fn scramble_construct(req_json: &str) -> Result<String, JsValue> {
    #[derive(Deserialize)]
    struct FullReq {
        sequence: String,
        regions: Vec<Region>,
        config: Option<serde_json::Value>,
        fast: Option<bool>,
    }

    let req: FullReq = serde_json::from_str(req_json)
        .map_err(|e| JsValue::from_str(&format!("Parse error: {e}")))?;

    let seq = req.sequence.to_uppercase();
    let fast = req.fast.unwrap_or(false);
    let mut regions = req.regions;
    regions.sort_by_key(|r| r.start);

    let parts: Vec<&Region> = regions.iter().filter(|r| r.region_type == "part").collect();
    let linkers: Vec<&Region> = regions
        .iter()
        .filter(|r| r.region_type == "linker")
        .collect();

    if parts.is_empty() {
        return Err(JsValue::from_str(
            "At least one part region must be defined.",
        ));
    }

    let concat_aa: String = parts
        .iter()
        .map(|r| {
            let end = (r.end + 1).min(seq.len());
            &seq[r.start..end]
        })
        .collect();

    let cfg = make_config(req.config.as_ref());
    let mut rng = SmallRng::seed_from_u64(random_seed());

    let result = run_scrambler(&concat_aa, &cfg, fast, &mut rng)
        .map_err(|e| JsValue::from_str(&e))?;

    // Split scrambled DNA back into per-part chunks by AA length.
    let mut part_dnas: HashMap<&str, String> = HashMap::new();
    let mut offset = 0usize;
    for r in &parts {
        let end = (r.end + 1).min(seq.len());
        let length = end - r.start;
        let dna_slice = result.dna[offset * 3..(offset + length) * 3].to_string();
        part_dnas.insert(&r.name, dna_slice);
        offset += length;
    }

    let linker_dnas: HashMap<&str, String> = linkers
        .iter()
        .map(|r| {
            let end = (r.end + 1).min(seq.len());
            (&r.name as &str, default_encode(&seq[r.start..end]))
        })
        .collect();

    let mut full_dna = String::new();
    let mut region_results: Vec<RegionResult> = Vec::new();

    for r in &regions {
        let end = (r.end + 1).min(seq.len());
        let aa = seq[r.start..end].to_string();
        let dna = part_dnas
            .get(r.name.as_str())
            .or_else(|| linker_dnas.get(r.name.as_str()))
            .cloned()
            .unwrap_or_default();
        full_dna.push_str(&dna);
        region_results.push(RegionResult {
            name: r.name.clone(),
            region_type: r.region_type.clone(),
            start: r.start,
            end: r.end,
            aa,
            dna,
        });
    }

    let response = ScrambleResponse {
        dna: full_dna,
        regions: region_results,
        objective: result.objective,
        status: result.status,
    };

    serde_json::to_string(&response).map_err(|e| JsValue::from_str(&e.to_string()))
}

/// Mirrors POST /api/swap-part.
#[wasm_bindgen]
pub fn swap_part(req_json: &str) -> Result<String, JsValue> {
    #[derive(Deserialize)]
    struct FullReq {
        new_aa: String,
        part_name: String,
        regions: Vec<Region>,
        region_dnas: HashMap<String, String>,
        fast: Option<bool>,
    }

    let req: FullReq = serde_json::from_str(req_json)
        .map_err(|e| JsValue::from_str(&format!("Parse error: {e}")))?;

    let new_aa = req.new_aa.to_uppercase();
    let fast = req.fast.unwrap_or(false);
    let cfg = ScramblerConfig::default();
    let mut rng = SmallRng::seed_from_u64(random_seed());

    let result = run_scrambler(&new_aa, &cfg, fast, &mut rng)
        .map_err(|e| JsValue::from_str(&e))?;

    let swapped_dna = result.dna;
    let mut regions = req.regions;
    regions.sort_by_key(|r| r.start);

    let full_dna: String = regions
        .iter()
        .map(|r| {
            if r.name == req.part_name {
                swapped_dna.clone()
            } else {
                req.region_dnas.get(&r.name).cloned().unwrap_or_default()
            }
        })
        .collect();

    let response = SwapPartResponse {
        dna: full_dna,
        swapped_dna,
    };

    serde_json::to_string(&response).map_err(|e| JsValue::from_str(&e.to_string()))
}
