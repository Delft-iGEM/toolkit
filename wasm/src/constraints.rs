pub static DEFAULT_FORBIDDEN_SITES: &[&str] = &[
    "GGTCTC", // BsaI
    "GAGACG", // BsaI RC (partial, matches original Python)
    "CATATG", // NdeI
    "GAAGAC", // BseRI
    "GGATCC", // BamHI
    "TCTAGA", // XbaI
];

pub fn rc(seq: &str) -> String {
    seq.chars()
        .rev()
        .map(|c| match c.to_ascii_uppercase() {
            'A' => 'T',
            'T' => 'A',
            'G' => 'C',
            'C' => 'G',
            _ => 'N',
        })
        .collect()
}

pub fn has_forbidden_site(nts: &str, sites: &[String]) -> bool {
    let upper = nts.to_uppercase();
    for site in sites {
        let s = site.to_uppercase();
        let s_rc = rc(&s).to_uppercase();
        if upper.contains(s.as_str()) || upper.contains(s_rc.as_str()) {
            return true;
        }
    }
    false
}

pub fn has_homopolymer(nts: &str) -> bool {
    let mut g_run = 0u32;
    let mut cat_run = 0u32;
    for c in nts.chars().map(|c| c.to_ascii_uppercase()) {
        if c == 'G' {
            g_run += 1;
            if g_run >= 6 {
                return true;
            }
        } else {
            g_run = 0;
        }
        if matches!(c, 'C' | 'A' | 'T') {
            cat_run += 1;
            if cat_run >= 8 {
                return true;
            }
        } else {
            cat_run = 0;
        }
    }
    false
}
