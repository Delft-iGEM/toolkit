"""
Codon scrambling via MILP on a layered De Bruijn graph.

Tang & Chilkoti, Nat Mater 2016, 15(4):419-424.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass, field
from itertools import product
from typing import Dict, List, Optional, Set, Tuple
import random as rand

import pulp
import seqfold

# ---------------------------------------------------------------------------
# Codon table — standard E. coli / NCBI table 11
# ---------------------------------------------------------------------------

CODON_TABLE: Dict[str, List[str]] = {
    "A": ["GCT", "GCC", "GCA", "GCG"],
    "R": ["CGT", "CGC", "CGA", "CGG", "AGA", "AGG"],
    "N": ["AAT", "AAC"],
    "D": ["GAT", "GAC"],
    "C": ["TGT", "TGC"],
    "Q": ["CAA", "CAG"],
    "E": ["GAA", "GAG"],
    "G": ["GGT", "GGC", "GGA", "GGG"],
    "H": ["CAT", "CAC"],
    "I": ["ATT", "ATC", "ATA"],
    "L": ["TTA", "TTG", "CTT", "CTC", "CTA", "CTG"],
    "K": ["AAA", "AAG"],
    "M": ["ATG"],
    "F": ["TTT", "TTC"],
    "P": ["CCT", "CCC", "CCA", "CCG"],
    "S": ["TCT", "TCC", "TCA", "TCG", "AGT", "AGC"],
    "T": ["ACT", "ACC", "ACA", "ACG"],
    "W": ["TGG"],
    "Y": ["TAT", "TAC"],
    "V": ["GTT", "GTC", "GTA", "GTG"],
    "*": ["TAA", "TAG", "TGA"],
}

# Common restriction sites to exclude from generated sequences
DEFAULT_FORBIDDEN_SITES: List[str] = [
    "GGTCTC",  # BsaI
    "GAGACG",  # BsaI reverse complement (partial)
    "CATATG",  # NdeI
    "GAAGAC",  # BseRI
    "GGATCC",  # BamHI
    "TCTAGA",  # XbaI
]

# Shine-Dalgarno anti-sequence for iRBS detection
_ANTI_SD = "ACCTCCTTA"

R_KCAL = 1.987e-3  # kcal/(mol·K)


# ---------------------------------------------------------------------------
# Public data types
# ---------------------------------------------------------------------------

@dataclass
class ScramblerConfig:
    k: int = 3
    """Window size: number of consecutive codons per vertex."""

    temperature: float = 323.15
    """Temperature in Kelvin for Boltzmann weighting (paper: 50 °C = 323.15 K)."""

    forbidden_sites: List[str] = field(default_factory=lambda: list(DEFAULT_FORBIDDEN_SITES))
    """Nucleotide subsequences that must not appear in any arc."""

    forbidden_homopolymers: bool = True
    """Reject arcs with ≥6 consecutive G's or ≥8 consecutive C/A/T."""

    forbidden_irbs: bool = True
    """Reject arcs whose nucleotides hybridise strongly to the anti-SD sequence."""

    irbs_dg_threshold: float = -8.0
    """ΔG threshold (kcal/mol) for iRBS rejection."""

    allowed_codons: Optional[Dict[str, List[str]]] = None
    """Override allowed codons per amino acid (subset of CODON_TABLE)."""

    subseq_min_len: int = 6
    """Minimum subsequence length to include in the repeat-penalty objective."""

    subseq_max_len: int = 18
    """Maximum subsequence length to include in the repeat-penalty objective."""

    solver_time_limit: Optional[int] = None
    """Wall-clock seconds to give the MILP solver (None = no limit)."""


@dataclass
class ScramblerResult:
    dna: str
    """Optimized DNA coding sequence (5'→3')."""

    objective: float
    """MILP objective value (lower = less repetitive)."""

    protein: str
    """Input amino acid sequence."""

    status: str
    """Solver status string."""


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _codon_table(config: ScramblerConfig) -> Dict[str, List[str]]:
    if config.allowed_codons:
        return config.allowed_codons
    return CODON_TABLE


def _rc(seq: str) -> str:
    comp = str.maketrans("ACGTacgt", "TGCAtgca")
    return seq.translate(comp)[::-1]


def _has_forbidden_pattern(nts: str, forbidden_sites: List[str], check_homopolymer: bool) -> bool:
    upper = nts.upper()
    for site in forbidden_sites:
        s = site.upper()
        if s in upper or _rc(s).upper() in upper:
            return True
    if check_homopolymer:
        if re.search(r"G{6}", upper):
            return True
        if re.search(r"[CAT]{8}", upper):
            return True
    return False


def _has_irbs(nts: str, threshold: float, temp: float) -> bool:
    """Reject if ΔG of hybridisation to anti-SD is below threshold."""
    upper = nts.upper()
    try:
        result = seqfold.fold(upper + "NNNN" + _ANTI_SD, temp=temp - 273.15)
        dg = seqfold.dg(result)
        return dg < threshold
    except BaseException:
        return False


def _arc_dg(nts: str, temp: float) -> float:
    """Minimum folding ΔG of a nucleotide string (kcal/mol)."""
    # seqfold's Rust core panics on sequences ≤ 11 nt (off-by-one in fold.rs:767).
    if len(nts) < 12:
        return 0.0
    try:
        result = seqfold.fold(nts.upper(), temp=temp - 273.15)
        return seqfold.dg(result)
    except BaseException:
        return 0.0


def _boltzmann(dg: float, temp: float) -> float:
    return math.exp(-dg / (R_KCAL * temp))


# ---------------------------------------------------------------------------
# Graph construction
# ---------------------------------------------------------------------------

def _build_graph(
    protein: str,
    config: ScramblerConfig,
) -> Tuple[
    Dict[Tuple[int, str], int],   # vertex → id
    List[Tuple[int, int, str]],   # arcs: (src_id, dst_id, nucleotide_string)
]:
    table = _codon_table(config)
    k = config.k
    n = len(protein)

    if n < k + 1:
        raise ValueError(f"Protein length {n} must be > k={k}")

    vertex_map: Dict[Tuple[int, str], int] = {}
    arcs: List[Tuple[int, int, str]] = []

    def _vid(pos: int, window: str) -> int:
        key = (pos, window)
        if key not in vertex_map:
            vertex_map[key] = len(vertex_map)
        return vertex_map[key]

    for i in range(n - k):
        # Enumerate all k-codon windows at position i and i+1
        codons_here = [table.get(aa, []) for aa in protein[i : i + k]]
        codons_next = table.get(protein[i + k], [])

        if any(len(c) == 0 for c in codons_here) or len(codons_next) == 0:
            continue

        for window_here in product(*codons_here):
            prefix_nts = "".join(window_here)

            for last_codon in codons_next:
                arc_nts = prefix_nts + last_codon

                # Arc-level filters
                if _has_forbidden_pattern(arc_nts, config.forbidden_sites, config.forbidden_homopolymers):
                    continue
                if config.forbidden_irbs and _has_irbs(arc_nts, config.irbs_dg_threshold, config.temperature):
                    continue

                # Suffix window for destination vertex
                suffix_nts = prefix_nts[3:] + last_codon  # drop first codon, append last

                src = _vid(i, prefix_nts)
                dst = _vid(i + 1, suffix_nts)
                arcs.append((src, dst, arc_nts))

    return vertex_map, arcs


# ---------------------------------------------------------------------------
# Subsequence repeat catalog
# ---------------------------------------------------------------------------

def _build_subseq_catalog(
    arcs: List[Tuple[int, int, str]],
    min_len: int,
    max_len: int,
) -> Dict[str, List[int]]:
    """Return mapping subseq → list of arc indices that contain it."""
    catalog: Dict[str, List[int]] = {}
    for arc_idx, (_, _, nts) in enumerate(arcs):
        upper = nts.upper()
        L = len(upper)
        for length in range(min_len, min(max_len + 1, L + 1)):
            for start in range(L - length + 1):
                s = upper[start : start + length]
                catalog.setdefault(s, []).append(arc_idx)
    # Keep only subsequences that appear in ≥2 arcs (others contribute 0 to obj)
    return {s: idxs for s, idxs in catalog.items() if len(set(idxs)) >= 2}


# ---------------------------------------------------------------------------
# MILP formulation
# ---------------------------------------------------------------------------

def _solve_milp(
    protein: str,
    vertex_map: Dict[Tuple[int, str], int],
    arcs: List[Tuple[int, int, str]],
    config: ScramblerConfig,
) -> Tuple[Optional[List[int]], float, str]:
    """
    Returns (selected_arc_indices, objective_value, status).
    The layered-DAG structure (each arc advances position i→i+1) means
    subtour elimination constraints are not needed.
    """
    k = config.k
    n = len(protein)
    num_arcs = len(arcs)

    if num_arcs == 0:
        return None, float("inf"), "INFEASIBLE"

    prob = pulp.LpProblem("codon_scramble", pulp.LpMinimize)

    # Arc binary variables
    x = [pulp.LpVariable(f"x_{i}", cat="Binary") for i in range(num_arcs)]

    # Build adjacency structures
    out_arcs: Dict[int, List[int]] = {}  # vertex_id → arc indices leaving it
    in_arcs: Dict[int, List[int]] = {}   # vertex_id → arc indices entering it
    for idx, (src, dst, _) in enumerate(arcs):
        out_arcs.setdefault(src, []).append(idx)
        in_arcs.setdefault(dst, []).append(idx)

    # Source vertices: position 0 (no incoming arc from within the path)
    source_vids: Set[int] = {vid for (pos, _), vid in vertex_map.items() if pos == 0}
    # Sink vertices: position n-k (no outgoing arc to within the path)
    sink_vids: Set[int] = {vid for (pos, _), vid in vertex_map.items() if pos == n - k}

    # Flow constraints
    # Source vertices (pos=0): no incoming, at most one outgoing.
    # Sink vertices (pos=n-k): no outgoing, at most one incoming.
    # Intermediate: conservation (in == out) and capacity <= 1.
    for (pos, _), vid in vertex_map.items():
        out_sum = pulp.lpSum(x[i] for i in out_arcs.get(vid, []))
        in_sum = pulp.lpSum(x[i] for i in in_arcs.get(vid, []))
        if vid in source_vids:
            prob += in_sum == 0, f"src_in_{vid}"
            prob += out_sum <= 1, f"src_out_{vid}"
        elif vid in sink_vids:
            prob += out_sum == 0, f"snk_out_{vid}"
            prob += in_sum <= 1, f"snk_in_{vid}"
        else:
            prob += out_sum == in_sum, f"flow_{vid}"
            prob += out_sum <= 1, f"cap_out_{vid}"

    # Exactly one path from start to end
    prob += pulp.lpSum(x[i] for i in range(num_arcs) if arcs[i][0] in source_vids) == 1, "one_source"
    prob += pulp.lpSum(x[i] for i in range(num_arcs) if arcs[i][1] in sink_vids) == 1, "one_sink"

    # Subsequence repeat penalty
    catalog = _build_subseq_catalog(arcs, config.subseq_min_len, config.subseq_max_len)

    obj_terms = []
    for si, (subseq, arc_indices) in enumerate(catalog.items()):
        unique_arcs = list(set(arc_indices))
        if len(unique_arcs) < 2:
            continue
        dg = _arc_dg(subseq, config.temperature)
        w = _boltzmann(dg, config.temperature)
        # n_s >= sum(x_a for a containing s) - 1, n_s >= 0
        n_s = pulp.LpVariable(f"n_{si}", lowBound=0, cat="Integer")
        prob += n_s >= pulp.lpSum(x[i] for i in unique_arcs) - 1, f"ns_{si}"
        obj_terms.append(w * n_s)

    prob += pulp.lpSum(obj_terms)

    # Solve
    solver_kwargs: dict = {"msg": 0}
    if config.solver_time_limit is not None:
        solver_kwargs["timeLimit"] = config.solver_time_limit

    solver = pulp.PULP_CBC_CMD(**solver_kwargs)
    prob.solve(solver)

    status = pulp.LpStatus[prob.status]
    if prob.status not in (1, -2):  # 1=Optimal, -2=Not solved (time limit)
        return None, float("inf"), status

    selected = [i for i, v in enumerate(x) if pulp.value(v) is not None and pulp.value(v) > 0.5]
    obj_val = pulp.value(prob.objective) or 0.0
    return selected, obj_val, status


# ---------------------------------------------------------------------------
# Path decoding
# ---------------------------------------------------------------------------

def _decode_path(
    protein: str,
    vertex_map: Dict[Tuple[int, str], int],
    arcs: List[Tuple[int, int, str]],
    selected: List[int],
    k: int,
) -> str:
    """Reconstruct the DNA sequence from selected arc indices."""
    n = len(protein)
    # Build position → arc mapping
    pos_arc: Dict[int, Tuple[int, int, str]] = {}
    id_to_pos: Dict[int, int] = {vid: pos for (pos, _), vid in vertex_map.items()}
    for i in selected:
        src, dst, nts = arcs[i]
        pos = id_to_pos[src]
        pos_arc[pos] = (src, dst, nts)

    # Walk from position 0
    dna_parts: List[str] = []
    pos = 0
    while pos in pos_arc:
        _, _, nts = pos_arc[pos]
        if pos == 0:
            dna_parts.append(nts)  # full k+1 codons
        else:
            dna_parts.append(nts[-3:])  # append only the new codon
        pos += 1

    return "".join(dna_parts)


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def fake_scramble(protein: str, config: Optional[ScramblerConfig] = None):
    dna = ""
    for AA in protein:
        dna += rand.choice(CODON_TABLE.get(AA, ["AUG"]))

    return ScramblerResult(
        dna=dna,
        objective=0,
        protein=protein,
        status="Optimal",
    )

def scramble(
    protein: str,
    config: Optional[ScramblerConfig] = None,
) -> ScramblerResult:
    """
    Return the optimized synonymous DNA sequence for *protein*.

    Parameters
    ----------
    protein:
        Single-letter amino acid sequence. Stop codons (*) may be included.
    config:
        Tuning parameters. Defaults are sensible for small ELP repeats.
    """
    if config is None:
        config = ScramblerConfig()

    protein = protein.upper().strip()
    if not protein:
        raise ValueError("Protein sequence is empty.")

    table = _codon_table(config)
    unknown = set(protein) - set(table)
    if unknown:
        raise ValueError(f"Unknown amino acid(s): {unknown}")

    vertex_map, arcs = _build_graph(protein, config)

    if not arcs:
        raise RuntimeError(
            "No arcs remain after filtering. Relax forbidden-site constraints "
            "or reduce k."
        )

    selected, obj_val, status = _solve_milp(protein, vertex_map, arcs, config)

    if selected is None:
        raise RuntimeError(f"MILP solver returned status '{status}'. No solution found.")

    dna = _decode_path(protein, vertex_map, arcs, selected, config.k)

    # Verify translation
    translated = _translate(dna)
    if translated.rstrip("*") != protein.rstrip("*"):
        raise RuntimeError(
            f"Decoded DNA translates to '{translated}', expected '{protein}'. "
            "This is a bug — please report it."
        )

    return ScramblerResult(
        dna=dna,
        objective=obj_val,
        protein=protein,
        status=status,
    )


def _translate(dna: str) -> str:
    """Translate a DNA sequence using the standard genetic code."""
    # Build reverse codon table
    rev: Dict[str, str] = {}
    for aa, codons in CODON_TABLE.items():
        for c in codons:
            rev[c.upper()] = aa
    result = []
    for i in range(0, len(dna) - 2, 3):
        codon = dna[i : i + 3].upper()
        result.append(rev.get(codon, "?"))
    return "".join(result)
