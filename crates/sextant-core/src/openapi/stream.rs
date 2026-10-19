//! Reading `components.schemas` of an OpenAPI document one schema at a time: the rest of the document is skipped as
//! it is read ([`IgnoredAny`]), and each schema is handed over as a small [`Value`] and dropped before the next is
//! read, so a 16 MiB document never exists as one parsed tree (several times its size in memory).

use std::fmt;

use serde::de::{DeserializeSeed, Deserializer, IgnoredAny, MapAccess, Visitor};
use serde_json::Value;

/// Called with each schema's name and the schema.
pub(super) type Sink<'a> = dyn FnMut(String, Value) + 'a;

/// The whole document: only `components` is entered.
pub(super) struct Document<'s, 'a>(pub &'s mut Sink<'a>);
/// `components`: only `schemas` is entered.
struct Components<'s, 'a>(&'s mut Sink<'a>);
/// `components.schemas`: every entry goes to the sink.
struct Schemas<'s, 'a>(&'s mut Sink<'a>);

impl<'de> DeserializeSeed<'de> for Document<'_, '_> {
    type Value = ();
    fn deserialize<D: Deserializer<'de>>(self, d: D) -> Result<(), D::Error> {
        d.deserialize_map(self)
    }
}

impl<'de> Visitor<'de> for Document<'_, '_> {
    type Value = ();
    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("an OpenAPI document")
    }
    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<(), A::Error> {
        while let Some(key) = map.next_key::<String>()? {
            if key == "components" {
                map.next_value_seed(Components(&mut *self.0))?;
            } else {
                map.next_value::<IgnoredAny>()?;
            }
        }
        Ok(())
    }
}

impl<'de> DeserializeSeed<'de> for Components<'_, '_> {
    type Value = ();
    fn deserialize<D: Deserializer<'de>>(self, d: D) -> Result<(), D::Error> {
        d.deserialize_map(self)
    }
}

impl<'de> Visitor<'de> for Components<'_, '_> {
    type Value = ();
    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("the components of an OpenAPI document")
    }
    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<(), A::Error> {
        while let Some(key) = map.next_key::<String>()? {
            if key == "schemas" {
                map.next_value_seed(Schemas(&mut *self.0))?;
            } else {
                map.next_value::<IgnoredAny>()?;
            }
        }
        Ok(())
    }
}

impl<'de> DeserializeSeed<'de> for Schemas<'_, '_> {
    type Value = ();
    fn deserialize<D: Deserializer<'de>>(self, d: D) -> Result<(), D::Error> {
        d.deserialize_map(self)
    }
}

impl<'de> Visitor<'de> for Schemas<'_, '_> {
    type Value = ();
    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("a map of schemas")
    }
    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<(), A::Error> {
        while let Some((name, schema)) = map.next_entry::<String, Value>()? {
            (self.0)(name, schema);
        }
        Ok(())
    }
}
