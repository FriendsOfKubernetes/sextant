//! Kubernetes resource quantities ("250m", "1.5Gi", "123456n", "1e3") as plain numbers in base units.

/// The value of a quantity in base units (cores for CPU, bytes for memory); `None` if it does not parse.
pub(crate) fn parse_quantity(text: &str) -> Option<f64> {
    let text = text.trim();
    if text.is_empty() {
        return None;
    }
    const SUFFIXES: &[(&str, f64)] = &[
        ("Ki", 1024.0),
        ("Mi", 1048576.0),
        ("Gi", 1073741824.0),
        ("Ti", 1099511627776.0),
        ("Pi", 1125899906842624.0),
        ("Ei", 1152921504606846976.0),
        ("n", 1e-9),
        ("u", 1e-6),
        ("m", 1e-3),
        ("k", 1e3),
        ("M", 1e6),
        ("G", 1e9),
        ("T", 1e12),
        ("P", 1e15),
        ("E", 1e18),
    ];
    for (suffix, factor) in SUFFIXES {
        if let Some(number) = text.strip_suffix(suffix) {
            // "1E" is exa, but "1e3" is an exponent and is handled below.
            if let Ok(value) = number.parse::<f64>() {
                return Some(value * factor);
            }
        }
    }
    text.parse::<f64>().ok().filter(|v| v.is_finite())
}

#[cfg(test)]
mod tests {
    use super::parse_quantity;

    #[test]
    fn quantities_from_metrics_server() {
        assert_eq!(parse_quantity("250m"), Some(0.25));
        assert_eq!(parse_quantity("2"), Some(2.0));
        assert_eq!(parse_quantity("1500000n"), Some(0.0015));
        assert_eq!(parse_quantity("10Ki"), Some(10240.0));
        assert_eq!(parse_quantity("1.5Gi"), Some(1610612736.0));
        assert_eq!(parse_quantity("128M"), Some(128e6));
        assert_eq!(parse_quantity("1e3"), Some(1000.0));
        assert_eq!(parse_quantity(""), None);
        assert_eq!(parse_quantity("lots"), None);
    }
}
