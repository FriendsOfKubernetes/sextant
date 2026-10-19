//! Fill levels of claims from Prometheus (#152): the kubelet's `kubelet_volume_stats_*` series, one fixed query per
//! field. The queries name no object (nothing from the caller goes into them); the answer is capped by `merge`.

use std::collections::BTreeMap;

use super::Prometheus;
use crate::error::CoreResult;
use crate::metrics::volumes::{VolumeUsage, merge};

/// The fields and their series. `max by` folds the series of several scrapes (or several mounts) of one claim.
pub(crate) const VOLUME_QUERIES: [(Field, &str); 6] = [
    (Field::Capacity, "kubelet_volume_stats_capacity_bytes"),
    (Field::Used, "kubelet_volume_stats_used_bytes"),
    (Field::Available, "kubelet_volume_stats_available_bytes"),
    (Field::Inodes, "kubelet_volume_stats_inodes"),
    (Field::InodesUsed, "kubelet_volume_stats_inodes_used"),
    (Field::InodesFree, "kubelet_volume_stats_inodes_free"),
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Field {
    Capacity,
    Used,
    Available,
    Inodes,
    InodesUsed,
    InodesFree,
}

pub(crate) fn query_of(metric: &str) -> String {
    format!(r#"max by (namespace, persistentvolumeclaim) ({metric}{{persistentvolumeclaim!=""}})"#)
}

/// Every claim Prometheus has the stats of, and whether some were left out. Fails only when the capacity and used
/// queries fail both; a missing inode series leaves those fields empty.
pub(crate) async fn volume_stats(prometheus: &Prometheus) -> CoreResult<(Vec<VolumeUsage>, bool)> {
    let answers =
        futures::future::join_all(VOLUME_QUERIES.iter().map(|(field, metric)| async move {
            (*field, prometheus.query(&query_of(metric)).await)
        }))
        .await;
    let mut by_claim: BTreeMap<(String, String), VolumeUsage> = BTreeMap::new();
    let mut first_error = None;
    let mut sized = false;
    for (field, answer) in answers {
        let samples = match answer {
            Ok(samples) => samples,
            Err(err) => {
                first_error.get_or_insert(err);
                continue;
            }
        };
        sized |= matches!(field, Field::Capacity | Field::Used);
        for (labels, value) in samples {
            let (Some(ns), Some(claim)) =
                (labels.get("namespace"), labels.get("persistentvolumeclaim"))
            else {
                continue;
            };
            let usage = by_claim
                .entry((ns.clone(), claim.clone()))
                .or_insert_with(|| VolumeUsage {
                    namespace: ns.clone(),
                    claim: claim.clone(),
                    ..VolumeUsage::default()
                });
            let slot = match field {
                Field::Capacity => &mut usage.capacity_bytes,
                Field::Used => &mut usage.used_bytes,
                Field::Available => &mut usage.available_bytes,
                Field::Inodes => &mut usage.inodes,
                Field::InodesUsed => &mut usage.inodes_used,
                Field::InodesFree => &mut usage.inodes_free,
            };
            *slot = Some(value);
        }
    }
    if !sized && let Some(err) = first_error {
        return Err(err);
    }
    Ok(merge(by_claim.into_values().collect()))
}
