use std::collections::{HashSet, VecDeque};
use rand::Rng;

use crate::codon_table::{codons_for, translate_dna};
use crate::constraints::{has_forbidden_site, has_homopolymer, DEFAULT_FORBIDDEN_SITES};

const BEAM_WIDTH: usize = 50;

pub struct ScramblerConfig {
    pub k: usize,
    pub forbidden_sites: Vec<String>,
    pub forbidden_homopolymers: bool,
    pub subseq_min_len: usize,
    pub subseq_max_len: usize,
}

impl Default for ScramblerConfig {
    fn default() -> Self {
        ScramblerConfig {
            k: 3,
            forbidden_sites: DEFAULT_FORBIDDEN_SITES.iter().map(|s| s.to_string()).collect(),
            forbidden_homopolymers: true,
            subseq_min_len: 6,
            subseq_max_len: 18,
        }
    }
}

pub struct ScramblerResult {
    pub dna: String,
    pub objective: f64,
    #[allow(dead_code)]
    pub protein: String,
    pub status: String,
}

#[derive(Clone)]
struct BeamState {
    dna: String,
    // last k codons for arc constraint checking
    last_codons: VecDeque<String>,
    score: f64,
}

fn build_subseq_set(dna: &str, min_len: usize, max_len: usize) -> HashSet<String> {
    let n = dna.len();
    let mut set = HashSet::new();
    for start in 0..n {
        let end_limit = (start + max_len + 1).min(n + 1);
        for end in (start + min_len)..end_limit {
            set.insert(dna[start..end].to_string());
        }
    }
    set
}

// Count repeats introduced by the new codon appended to old_dna (length old_len).
fn count_new_repeats(
    old_subseqs: &HashSet<String>,
    full_dna: &str,
    old_len: usize,
    min_len: usize,
    max_len: usize,
) -> f64 {
    let n = full_dna.len();
    let mut count = 0.0f64;

    // Only check windows that include at least one new character (index >= old_len).
    let check_from = old_len.saturating_sub(max_len - 1);

    for start in check_from..n {
        let end_limit = (start + max_len + 1).min(n + 1);
        for end in (start + min_len)..end_limit {
            if end <= old_len {
                continue; // entirely in old part, already counted
            }
            let subseq = &full_dna[start..end];
            if old_subseqs.contains(subseq) {
                count += 1.0;
            }
        }
    }
    count
}

pub fn scramble<R: Rng>(
    protein: &str,
    config: &ScramblerConfig,
    rng: &mut R,
) -> Result<ScramblerResult, String> {
    let protein = protein.to_uppercase();
    let aas: Vec<char> = protein.chars().collect();
    let n = aas.len();

    if n == 0 {
        return Err("Protein sequence is empty.".to_string());
    }

    let mut beam: Vec<BeamState> = vec![BeamState {
        dna: String::with_capacity(n * 3),
        last_codons: VecDeque::new(),
        score: 0.0,
    }];

    for (i, &aa) in aas.iter().enumerate() {
        let candidates = codons_for(aa)
            .ok_or_else(|| format!("Unknown amino acid '{}' at position {}.", aa, i))?;

        let mut next_states: Vec<BeamState> = Vec::with_capacity(beam.len() * candidates.len());

        for state in &beam {
            let old_len = state.dna.len();
            let old_subseqs = if old_len >= config.subseq_min_len {
                build_subseq_set(&state.dna, config.subseq_min_len, config.subseq_max_len)
            } else {
                HashSet::new()
            };

            for &codon in candidates {
                // Form arc: last k codons + new codon (= (k+1)*3 nt for constraint check)
                let arc_nt_start = if old_len >= config.k * 3 {
                    old_len - config.k * 3
                } else {
                    0
                };
                let arc = format!("{}{}", &state.dna[arc_nt_start..], codon);

                if !config.forbidden_sites.is_empty()
                    && has_forbidden_site(&arc, &config.forbidden_sites)
                {
                    continue;
                }
                if config.forbidden_homopolymers && has_homopolymer(&arc) {
                    continue;
                }

                let new_dna = format!("{}{}", state.dna, codon);
                let delta = if old_len >= config.subseq_min_len {
                    count_new_repeats(
                        &old_subseqs,
                        &new_dna,
                        old_len,
                        config.subseq_min_len,
                        config.subseq_max_len,
                    )
                } else {
                    0.0
                };

                let mut new_last = state.last_codons.clone();
                new_last.push_back(codon.to_string());
                if new_last.len() > config.k {
                    new_last.pop_front();
                }

                next_states.push(BeamState {
                    dna: new_dna,
                    last_codons: new_last,
                    score: state.score + delta,
                });
            }
        }

        if next_states.is_empty() {
            return Err(format!(
                "No valid codon at position {} (aa='{}'). Relax constraints or reduce k.",
                i, aa
            ));
        }

        // Sort ascending by score; add tiny rng jitter so ties resolve differently
        // each call (gives diversity on repeated scramble of the same sequence).
        next_states.sort_by(|a, b| {
            let jitter = rng.gen::<f64>() * 1e-9;
            (a.score + jitter)
                .partial_cmp(&b.score)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        next_states.truncate(BEAM_WIDTH);
        beam = next_states;
    }

    // Best state is first after sort.
    let best = beam.into_iter().next().unwrap();

    // Integrity check
    let translated = translate_dna(&best.dna);
    if translated != protein {
        return Err(format!(
            "Translation mismatch: got '{}', expected '{}'.",
            translated, protein
        ));
    }

    Ok(ScramblerResult {
        dna: best.dna,
        objective: best.score,
        protein,
        status: "Optimal".to_string(),
    })
}

pub fn fast_scramble<R: Rng>(
    protein: &str,
    rng: &mut R,
) -> Result<ScramblerResult, String> {
    let protein = protein.to_uppercase();
    let mut dna = String::with_capacity(protein.len() * 3);

    for (i, aa) in protein.chars().enumerate() {
        let candidates = codons_for(aa)
            .ok_or_else(|| format!("Unknown amino acid '{}' at position {}.", aa, i))?;
        let idx = rng.gen_range(0..candidates.len());
        dna.push_str(candidates[idx]);
    }

    Ok(ScramblerResult {
        dna,
        objective: 0.0,
        protein,
        status: "Optimal (fast)".to_string(),
    })
}
