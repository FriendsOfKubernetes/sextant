//! The MCP token: 32 random bytes (base64url) in the file `mcp-token` of the config directory, readable only by the
//! user on Unix. It never appears in logs or errors: `Debug` and `Display` print `<hidden>`, and only
//! [`Token::as_str`] gives the text (for the `Authorization` header and the configuration snippets).

use std::fmt;
use std::io::{self, Write};
use std::path::Path;

use base64::Engine as _;

/// Random bytes in a token.
const TOKEN_BYTES: usize = 32;

#[derive(Clone, PartialEq, Eq)]
pub struct Token(String);

impl Token {
    /// A new token from the OS random source.
    pub fn generate() -> io::Result<Self> {
        let mut bytes = [0u8; TOKEN_BYTES];
        getrandom::fill(&mut bytes).map_err(|e| io::Error::other(e.to_string()))?;
        Ok(Self(
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes),
        ))
    }

    /// The token text — only for the `Authorization` header and the snippets the user copies.
    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// Whether `candidate` is this token. Takes the same time wherever the first difference is.
    pub fn matches(&self, candidate: &str) -> bool {
        let expected = self.0.as_bytes();
        let candidate = candidate.as_bytes();
        let mut diff = expected.len() ^ candidate.len();
        for (i, byte) in expected.iter().enumerate() {
            let other = candidate.get(i).copied().unwrap_or(0);
            diff |= usize::from(byte ^ other);
        }
        diff == 0
    }

    /// Whether a stored text is a token Sextant could have made (43 base64url characters).
    fn is_well_formed(text: &str) -> bool {
        base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(text)
            .is_ok_and(|bytes| bytes.len() == TOKEN_BYTES)
    }
}

impl fmt::Debug for Token {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Token(<hidden>)")
    }
}

impl fmt::Display for Token {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("<hidden>")
    }
}

/// The token in `path`, without creating one: `None` when the file is missing, empty or malformed (`sextant mcp`
/// reads the token of the running application this way and must never replace it).
pub fn load(path: &Path) -> io::Result<Option<Token>> {
    match std::fs::read_to_string(path) {
        Ok(text) if Token::is_well_formed(text.trim()) => Ok(Some(Token(text.trim().to_owned()))),
        Ok(_) => Ok(None),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}

/// The token in `path`; a missing, empty or malformed file gets a new token.
pub fn load_or_create(path: &Path) -> io::Result<Token> {
    match load(path)? {
        Some(token) => Ok(token),
        None => regenerate(path),
    }
}

/// A new token written to `path` (replacing the old one, which stops working).
pub fn regenerate(path: &Path) -> io::Result<Token> {
    let token = Token::generate()?;
    write_private(path, token.as_str().as_bytes())?;
    Ok(token)
}

/// Writes `contents` to `path` through a temporary file in the same directory, readable only by the user on Unix.
fn write_private(path: &Path, contents: &[u8]) -> io::Result<()> {
    let dir = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .ok_or_else(|| io::Error::other("the token file has no directory"))?;
    std::fs::create_dir_all(dir)?;
    let file_name = path
        .file_name()
        .ok_or_else(|| io::Error::other("the token file has no name"))?;
    let mut tmp_name = file_name.to_os_string();
    tmp_name.push(format!(".tmp-{}", std::process::id()));
    let tmp = dir.join(tmp_name);
    let written = (|| {
        let mut file = private_file(&tmp)?;
        file.write_all(contents)?;
        file.sync_all()?;
        drop(file);
        std::fs::rename(&tmp, path)
    })();
    if written.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    written
}

#[cfg(unix)]
fn private_file(path: &Path) -> io::Result<std::fs::File> {
    use std::os::unix::fs::OpenOptionsExt;
    std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path)
}

#[cfg(not(unix))]
fn private_file(path: &Path) -> io::Result<std::fs::File> {
    // Files in the user's profile are private to the user on Windows.
    std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .open(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_token_is_created_once_and_read_back() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config").join("mcp-token");
        let first = load_or_create(&path).unwrap();
        assert_eq!(first.as_str().len(), 43, "32 bytes in base64url");
        assert!(
            first
                .as_str()
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        );
        assert_eq!(load_or_create(&path).unwrap(), first);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), first.as_str());
    }

    #[test]
    fn load_reads_the_token_and_never_creates_one() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("mcp-token");
        assert_eq!(load(&path).unwrap(), None);
        assert!(!path.exists(), "load created a file");
        std::fs::write(&path, "short").unwrap();
        assert_eq!(load(&path).unwrap(), None);
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "short",
            "load replaced it"
        );

        let token = load_or_create(&path).unwrap();
        assert_eq!(load(&path).unwrap(), Some(token.clone()));
        std::fs::write(&path, format!("{}\n", token.as_str())).unwrap();
        assert_eq!(load(&path).unwrap(), Some(token));
    }

    #[test]
    fn regenerate_replaces_the_token() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("mcp-token");
        let old = load_or_create(&path).unwrap();
        let new = regenerate(&path).unwrap();
        assert_ne!(old, new);
        assert_eq!(load_or_create(&path).unwrap(), new);
        assert!(!new.matches(old.as_str()));
    }

    #[test]
    fn a_malformed_file_gets_a_new_token() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("mcp-token");
        std::fs::write(&path, "short").unwrap();
        let token = load_or_create(&path).unwrap();
        assert_ne!(token.as_str(), "short");
        assert_eq!(token.as_str().len(), 43);
    }

    #[cfg(unix)]
    #[test]
    fn the_file_is_readable_only_by_the_user() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("mcp-token");
        load_or_create(&path).unwrap();
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
        regenerate(&path).unwrap();
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
    }

    #[test]
    fn debug_and_display_hide_the_token() {
        let token = Token::generate().unwrap();
        let printed = format!("{token} {token:?} {:?}", Some(&token));
        assert!(!printed.contains(token.as_str()), "{printed}");
        assert!(printed.contains("<hidden>"));
    }

    #[test]
    fn only_the_same_text_matches() {
        let token = Token::generate().unwrap();
        let text = token.as_str().to_owned();
        assert!(token.matches(&text));
        assert!(!token.matches(""));
        assert!(!token.matches(&text[..42]));
        assert!(!token.matches(&format!("{text}x")));
        let mut changed = text.clone().into_bytes();
        changed[0] = if changed[0] == b'A' { b'B' } else { b'A' };
        assert!(!token.matches(std::str::from_utf8(&changed).unwrap()));
    }
}
