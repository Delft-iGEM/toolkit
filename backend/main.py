from typing import Dict, List, Optional

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from backend.codon_scrambler import CODON_TABLE, ScramblerConfig, fake_scramble, scramble

app = FastAPI(title="ELP Toolkit API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------------------
# Request / response models
# ---------------------------------------------------------------------------


class Region(BaseModel):
    name: str
    type: str  # "part" | "linker"
    start: int  # 0-indexed inclusive
    end: int    # 0-indexed inclusive


class ScrambleRequest(BaseModel):
    sequence: str
    regions: List[Region]
    config: Optional[Dict] = None


class RegionResult(BaseModel):
    name: str
    type: str
    start: int
    end: int
    aa: str
    dna: str


class ScrambleResponse(BaseModel):
    dna: str
    regions: List[RegionResult]
    objective: float
    status: str


class SwapPartRequest(BaseModel):
    new_aa: str
    part_name: str
    regions: List[Region]
    region_dnas: Dict[str, str]  # name → current DNA for linkers/other parts


class SwapPartResponse(BaseModel):
    dna: str
    swapped_dna: str


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _default_encode(aa_seq: str) -> str:
    """Encode an AA sequence using the first available codon for each residue."""
    return "".join(CODON_TABLE.get(aa.upper(), ["NNN"])[0] for aa in aa_seq)


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@app.post("/api/scramble", response_model=ScrambleResponse)
def scramble_construct(req: ScrambleRequest, fast: bool = False):
    seq = req.sequence.upper().strip()
    regions = sorted(req.regions, key=lambda r: r.start)

    parts = [r for r in regions if r.type == "part"]
    linkers = [r for r in regions if r.type == "linker"]

    if not parts:
        raise HTTPException(status_code=400, detail="At least one part region must be defined.")

    # Concatenate part AA sequences for joint scrambling so the MILP minimises
    # repetitiveness across all parts simultaneously.
    concat_aa = "".join(seq[r.start : r.end + 1] for r in parts)

    cfg = ScramblerConfig()
    if req.config:
        for key, val in req.config.items():
            if hasattr(cfg, key):
                setattr(cfg, key, val)

    fn = fake_scramble if fast else scramble
    print(f"Starting! (fast={fast})")
    try:
        result = fn(concat_aa, cfg)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))

    # Split scrambled DNA back into per-part chunks by AA length.
    part_dnas: Dict[str, str] = {}
    offset = 0
    for r in parts:
        length = r.end - r.start + 1
        part_dnas[r.name] = result.dna[offset * 3 : (offset + length) * 3]
        offset += length

    # Linkers get default codon assignment (anchored — not scrambled).
    linker_dnas: Dict[str, str] = {
        r.name: _default_encode(seq[r.start : r.end + 1]) for r in linkers
    }

    region_results: List[RegionResult] = []
    full_dna = ""
    for r in regions:
        aa = seq[r.start : r.end + 1]
        dna = part_dnas.get(r.name) or linker_dnas.get(r.name, "")
        full_dna += dna
        region_results.append(
            RegionResult(name=r.name, type=r.type, start=r.start, end=r.end, aa=aa, dna=dna)
        )

    return ScrambleResponse(
        dna=full_dna,
        regions=region_results,
        objective=result.objective,
        status=result.status,
    )


@app.post("/api/swap-part", response_model=SwapPartResponse)
def swap_part(req: SwapPartRequest, fast: bool = False):
    """Scramble a replacement AA sequence for one part; linker DNAs stay fixed."""
    new_aa = req.new_aa.upper().strip()

    fn = fake_scramble if fast else scramble
    try:
        result = fn(new_aa)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))

    swapped_dna = result.dna

    # Reconstruct full DNA: use new part DNA, keep everything else from req.region_dnas.
    regions_sorted = sorted(req.regions, key=lambda r: r.start)
    full_dna = "".join(
        swapped_dna if r.name == req.part_name else req.region_dnas.get(r.name, "")
        for r in regions_sorted
    )

    return SwapPartResponse(dna=full_dna, swapped_dna=swapped_dna)
