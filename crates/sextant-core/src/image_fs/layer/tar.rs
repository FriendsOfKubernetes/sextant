//! A synchronous tar reader for layer streams: ustar, GNU long names and pax records, with the metadata the viewer
//! shows (mode, owner, mtime). The block helpers are shared with `files.rs`.

use std::io::{Read, Write};

use crate::CoreResult;
use crate::files::{BLOCK, checksum_ok, pax_records, text};
use crate::image_fs::{limits, refused};

/// One header as read, before the path is normalised.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RawEntry {
    pub path: String,
    pub flag: u8,
    pub size: u64,
    pub mode: u32,
    pub uid: u64,
    pub gid: u64,
    pub user: Option<String>,
    pub group: Option<String>,
    pub mtime: u64,
    pub link: Option<String>,
}

impl RawEntry {
    /// Whether the entry's data follows its header (regular files and special entries with a size).
    fn carries_data(&self) -> bool {
        !matches!(self.flag, b'1' | b'2' | b'5')
    }
}

pub struct TarStream<R> {
    inner: R,
    /// Data of the current entry not read yet, padding included.
    pending: u64,
}

/// A stream error: the reader's own reason when it stopped on a limit, else what broke.
pub type StreamError = std::io::Error;

impl<R: Read> TarStream<R> {
    pub fn new(inner: R) -> Self {
        Self { inner, pending: 0 }
    }

    pub fn into_inner(self) -> R {
        self.inner
    }

    /// Fills `buf`; `false` when the stream ended before the first byte.
    fn read_full(&mut self, buf: &mut [u8]) -> Result<bool, StreamError> {
        let mut filled = 0;
        while filled < buf.len() {
            let n = self.inner.read(&mut buf[filled..])?;
            if n == 0 {
                if filled == 0 {
                    return Ok(false);
                }
                return Err(std::io::Error::new(
                    std::io::ErrorKind::UnexpectedEof,
                    "the layer ended inside a tar block",
                ));
            }
            filled += n;
        }
        Ok(true)
    }

    fn skip(&mut self, mut bytes: u64) -> Result<(), StreamError> {
        let mut buf = [0u8; 8192];
        while bytes > 0 {
            let want = bytes.min(buf.len() as u64) as usize;
            let n = self.inner.read(&mut buf[..want])?;
            if n == 0 {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::UnexpectedEof,
                    "the layer ended inside an entry",
                ));
            }
            bytes -= n as u64;
        }
        Ok(())
    }

    fn read_record(&mut self, size: u64) -> CoreResult<Result<Vec<u8>, StreamError>> {
        if size > limits::MAX_HEADER_BYTES {
            return Err(refused("a tar header record is larger than 2 MiB"));
        }
        let padded = (size as usize).div_ceil(BLOCK) * BLOCK;
        let mut data = vec![0u8; padded];
        match self.read_full(&mut data) {
            Ok(true) => {
                data.truncate(size as usize);
                Ok(Ok(data))
            }
            Ok(false) => Ok(Err(std::io::Error::new(
                std::io::ErrorKind::UnexpectedEof,
                "the layer ended inside a tar header",
            ))),
            Err(e) => Ok(Err(e)),
        }
    }

    /// The next entry; `None` at the end marker or the end of the stream. The current entry's data is skipped unless
    /// it was read with [`TarStream::copy_data`]. The outer error is a broken stream, the inner a refused archive.
    pub fn next_entry(&mut self) -> Result<CoreResult<Option<RawEntry>>, StreamError> {
        let pending = std::mem::take(&mut self.pending);
        self.skip(pending)?;
        let mut long_name: Option<String> = None;
        let mut long_link: Option<String> = None;
        let mut pax: Vec<(String, String)> = Vec::new();
        let mut header_bytes: u64 = 0;
        loop {
            let mut block = [0u8; BLOCK];
            if !self.read_full(&mut block)? || block.iter().all(|&b| b == 0) {
                return Ok(Ok(None));
            }
            if !checksum_ok(&block) {
                return Ok(Err(refused("a layer is not a tar stream")));
            }
            let size = match parse_number(&block[124..136]) {
                Ok(size) => size,
                Err(e) => return Ok(Err(e)),
            };
            let flag = block[156];
            if matches!(flag, b'L' | b'K' | b'x' | b'g') {
                header_bytes = header_bytes
                    .saturating_add(BLOCK as u64)
                    .saturating_add(size.div_ceil(BLOCK as u64) * BLOCK as u64);
                if header_bytes > limits::MAX_HEADER_BYTES {
                    return Ok(Err(refused("tar header records too large before an entry")));
                }
                let data = match self.read_record(size) {
                    Ok(Ok(data)) => data,
                    Ok(Err(e)) => return Err(e),
                    Err(e) => return Ok(Err(e)),
                };
                match flag {
                    b'L' => long_name = Some(text(&data)),
                    b'K' => long_link = Some(text(&data)),
                    b'x' => pax.extend(pax_records(&data)),
                    _ => {}
                }
                continue;
            }
            let field = |range: std::ops::Range<usize>| parse_number(&block[range]).unwrap_or(0);
            let ustar = &block[257..262] == b"ustar";
            let name = text(&block[..100]);
            let prefix = if ustar {
                text(&block[345..500])
            } else {
                String::new()
            };
            let short = if prefix.is_empty() {
                name
            } else {
                format!("{prefix}/{name}")
            };
            let non_empty = |s: String| Some(s).filter(|s| !s.is_empty());
            let mut entry = RawEntry {
                path: long_name.take().unwrap_or(short),
                flag,
                size,
                mode: (field(100..108) & 0o7777) as u32,
                uid: field(108..116),
                gid: field(116..124),
                user: if ustar {
                    non_empty(text(&block[265..297]))
                } else {
                    None
                },
                group: if ustar {
                    non_empty(text(&block[297..329]))
                } else {
                    None
                },
                mtime: field(136..148),
                link: long_link
                    .take()
                    .or_else(|| non_empty(text(&block[157..257]))),
            };
            for (key, value) in pax.drain(..) {
                match key.as_str() {
                    "path" => entry.path = value,
                    "linkpath" => entry.link = Some(value),
                    "size" => entry.size = value.parse().unwrap_or(entry.size),
                    "uid" => entry.uid = value.parse().unwrap_or(entry.uid),
                    "gid" => entry.gid = value.parse().unwrap_or(entry.gid),
                    "uname" => entry.user = non_empty(value),
                    "gname" => entry.group = non_empty(value),
                    "mtime" => {
                        let whole = value.split('.').next().unwrap_or("");
                        entry.mtime = whole.parse().unwrap_or(entry.mtime);
                    }
                    _ => {}
                }
            }
            let data = if entry.carries_data() { entry.size } else { 0 };
            self.pending = data.div_ceil(BLOCK as u64) * BLOCK as u64;
            return Ok(Ok(Some(entry)));
        }
    }

    /// Writes up to `max` bytes of the current entry (of `size` bytes) to `out`; the rest is skipped by the next
    /// [`TarStream::next_entry`]. Returns the bytes written.
    pub fn copy_data(
        &mut self,
        size: u64,
        max: u64,
        out: &mut dyn Write,
    ) -> Result<u64, StreamError> {
        let want = size.min(max);
        let mut left = want;
        let mut buf = vec![0u8; 64 * 1024];
        while left > 0 {
            let chunk = left.min(buf.len() as u64) as usize;
            let n = self.inner.read(&mut buf[..chunk])?;
            if n == 0 {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::UnexpectedEof,
                    "the layer ended inside a file",
                ));
            }
            out.write_all(&buf[..n])?;
            left -= n as u64;
        }
        self.pending = self.pending.saturating_sub(want);
        Ok(want)
    }
}

/// An octal number field, or GNU's base-256 form.
fn parse_number(field: &[u8]) -> CoreResult<u64> {
    if field[0] & 0x80 != 0 {
        let mut value: u64 = u64::from(field[0] & 0x7f);
        for &b in &field[1..] {
            value = value
                .checked_mul(256)
                .and_then(|v| v.checked_add(u64::from(b)))
                .ok_or_else(|| refused("a tar number is too large"))?;
        }
        return Ok(value);
    }
    let digits = text(field);
    let digits = digits.trim_matches(|c: char| c == ' ' || c == '\0');
    if digits.is_empty() {
        return Ok(0);
    }
    u64::from_str_radix(digits, 8).map_err(|_| refused("a tar header has a malformed number"))
}
