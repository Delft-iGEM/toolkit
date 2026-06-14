// Standard E. coli / NCBI table 11
pub static CODON_TABLE: &[(&str, &[&str])] = &[
    ("A", &["GCT", "GCC", "GCA", "GCG"]),
    ("R", &["CGT", "CGC", "CGA", "CGG", "AGA", "AGG"]),
    ("N", &["AAT", "AAC"]),
    ("D", &["GAT", "GAC"]),
    ("C", &["TGT", "TGC"]),
    ("Q", &["CAA", "CAG"]),
    ("E", &["GAA", "GAG"]),
    ("G", &["GGT", "GGC", "GGA", "GGG"]),
    ("H", &["CAT", "CAC"]),
    ("I", &["ATT", "ATC", "ATA"]),
    ("L", &["TTA", "TTG", "CTT", "CTC", "CTA", "CTG"]),
    ("K", &["AAA", "AAG"]),
    ("M", &["ATG"]),
    ("F", &["TTT", "TTC"]),
    ("P", &["CCT", "CCC", "CCA", "CCG"]),
    ("S", &["TCT", "TCC", "TCA", "TCG", "AGT", "AGC"]),
    ("T", &["ACT", "ACC", "ACA", "ACG"]),
    ("W", &["TGG"]),
    ("Y", &["TAT", "TAC"]),
    ("V", &["GTT", "GTC", "GTA", "GTG"]),
    ("*", &["TAA", "TAG", "TGA"]),
];

pub fn codons_for(aa: char) -> Option<&'static [&'static str]> {
    let key = if aa == '*' { "*" } else {
        // Safe: we only look up single ASCII chars
        CODON_TABLE.iter().find(|(k, _)| k.chars().next() == Some(aa)).map(|(k, _)| *k)?
    };
    CODON_TABLE.iter().find(|(k, _)| *k == key).map(|(_, c)| *c)
}

pub fn translate_codon(codon: &str) -> char {
    let upper = codon.to_uppercase();
    for (aa, codons) in CODON_TABLE {
        if codons.contains(&upper.as_str()) {
            return aa.chars().next().unwrap_or('?');
        }
    }
    '?'
}

pub fn translate_dna(dna: &str) -> String {
    let mut result = String::with_capacity(dna.len() / 3);
    let bytes = dna.as_bytes();
    let mut i = 0;
    while i + 3 <= bytes.len() {
        // Safety: dna is ASCII, slicing at byte boundaries
        let codon = &dna[i..i + 3];
        result.push(translate_codon(codon));
        i += 3;
    }
    result
}
