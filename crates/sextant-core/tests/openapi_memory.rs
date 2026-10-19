//! Peak memory of reading a large OpenAPI document (#151): read one schema at a time
//! (`GroupVersionSchemas::from_slice`) against parsing the whole document first. A test binary of its own, so the
//! counting allocator sees nothing but this test.
//!
//! ```sh
//! cargo test -p sextant-core --test openapi_memory -- --nocapture
//! ```

use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicUsize, Ordering};

use serde_json::{Value, json};
use sextant_core::openapi::GroupVersionSchemas;

struct Counting;

static CURRENT: AtomicUsize = AtomicUsize::new(0);
static PEAK: AtomicUsize = AtomicUsize::new(0);

unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let now = CURRENT.fetch_add(layout.size(), Ordering::SeqCst) + layout.size();
        PEAK.fetch_max(now, Ordering::SeqCst);
        unsafe { System.alloc(layout) }
    }
    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        CURRENT.fetch_sub(layout.size(), Ordering::SeqCst);
        unsafe { System.dealloc(ptr, layout) }
    }
}

#[global_allocator]
static ALLOCATOR: Counting = Counting;

/// The most memory `f` held above what was held when it started.
fn peak_of<T>(f: impl FnOnce() -> T) -> (T, usize) {
    let base = CURRENT.load(Ordering::SeqCst);
    PEAK.store(base, Ordering::SeqCst);
    let out = f();
    (out, PEAK.load(Ordering::SeqCst) - base)
}

/// About 15 MB: 2500 definitions of 24 fields with long descriptions, like a big CRD group.
fn large_document() -> Vec<u8> {
    let description = "A field of a large custom resource. ".repeat(6);
    let mut schemas = serde_json::Map::new();
    for i in 0..2500 {
        let mut props = serde_json::Map::new();
        for f in 0..24 {
            props.insert(
                format!("field{f}"),
                json!({ "type": "string", "description": description, "enum": ["a", "b", "c"] }),
            );
        }
        schemas.insert(
            format!("com.example.v1.Kind{i}"),
            json!({ "type": "object", "description": description, "properties": props,
                    "x-kubernetes-group-version-kind": [{ "group": "example.com", "version": "v1", "kind": format!("Kind{i}") }] }),
        );
    }
    serde_json::to_vec(&json!({ "openapi": "3.0.0", "components": { "schemas": schemas } }))
        .unwrap()
}

#[test]
fn reading_one_schema_at_a_time_holds_far_less_than_the_parsed_document() {
    let bytes = large_document();
    let size = bytes.len();
    let (whole, whole_peak) = peak_of(|| {
        let document: Value = serde_json::from_slice(&bytes).unwrap();
        GroupVersionSchemas::from_document(&document)
    });
    drop(whole);
    let before = CURRENT.load(Ordering::SeqCst);
    let (streamed, streamed_peak) = peak_of(|| GroupVersionSchemas::from_slice(&bytes).unwrap());
    let retained = CURRENT.load(Ordering::SeqCst) - before;
    assert_eq!(streamed.len(), 2500);
    let (kept, _) = peak_of(|| streamed.kind("example.com", "v1", "Kind7").unwrap());
    assert_eq!(kept.root.properties.as_ref().unwrap().len(), 24);
    let mb = |n: usize| n as f64 / 1_048_576.0;
    eprintln!(
        "document {:.1} MiB: parsed whole {:.1} MiB peak, one schema at a time {:.1} MiB peak \
         ({:.1} MiB of it is the compact result that is kept)",
        mb(size),
        mb(whole_peak),
        mb(streamed_peak),
        mb(retained)
    );
    // What stays is the compact form; the parsed document never exists as a whole.
    assert!(
        streamed_peak * 2 < whole_peak,
        "{streamed_peak} vs {whole_peak}"
    );
}
