//! YC discovery uses explicit profiles and read-only commands; credentials stay in yc.
use super::*;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum YandexEndpoint {
    External,
    Internal,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct YandexSelection {
    pub profile: String,
    pub endpoint: YandexEndpoint,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct YandexDiscovery {
    pub profiles: Vec<CloudAccount>,
    pub profile: Option<String>,
    pub clouds: Vec<CloudAccount>,
    pub cloud_id: Option<String>,
    pub problems: Vec<CloudProblem>,
}

pub(super) fn version(text: &str) -> Option<String> {
    text.trim()
        .strip_prefix("Yandex Cloud CLI ")?
        .split_whitespace()
        .next()
        .map(str::to_owned)
}

fn account(id: String, name: Option<String>, current: Option<&str>) -> CloudAccount {
    CloudAccount {
        is_default: current == Some(id.as_str()),
        name: name.filter(|s| !s.is_empty()).unwrap_or_else(|| id.clone()),
        id,
        region: None,
    }
}

pub(super) fn parse_profiles(text: &str) -> Result<Vec<CloudAccount>, String> {
    let mut profiles = Vec::new();
    for line in text.lines().map(str::trim).filter(|s| !s.is_empty()) {
        let (name, active) = match line.rsplit_once(char::is_whitespace) {
            Some((name, "ACTIVE")) => (name.trim_end(), true),
            _ => (line, false),
        };
        if name.is_empty()
            || name.contains(['{', '}', '[', ']'])
            || plain_arg(name, "profile").is_err()
        {
            return Err("yc returned an invalid profile list".into());
        }
        let mut value = account(name.to_owned(), None, None);
        value.is_default = active;
        profiles.push(value);
    }
    Ok(profiles)
}

pub(super) fn parse_accounts(
    text: &str,
    current: Option<&str>,
) -> Result<Vec<CloudAccount>, String> {
    let value = json_of(text)?;
    let entries = value.as_array().ok_or("yc returned a non-array list")?;
    entries
        .iter()
        .map(|entry| {
            let id = str_at(entry, "/id").ok_or("yc returned a list entry without an id")?;
            plain_arg(&id, "cloud or folder id").map_err(|_| "yc returned an invalid id")?;
            Ok(account(id, str_at(entry, "/name"), current))
        })
        .collect()
}

pub(super) fn parse_clusters(
    text: &str,
    folder: &str,
    selection: &YandexSelection,
) -> Result<Vec<CloudCluster>, String> {
    let value = json_of(text)?;
    let entries = value
        .as_array()
        .ok_or("yc returned a non-array cluster list")?;
    entries
        .iter()
        .map(|entry| {
            let id = str_at(entry, "/id").ok_or("yc returned a cluster without an id")?;
            plain_arg(&id, "cluster id").map_err(|_| "yc returned an invalid cluster id")?;
            let endpoint_path = match selection.endpoint {
                YandexEndpoint::External => "/master/endpoints/external_v4_endpoint",
                YandexEndpoint::Internal => "/master/endpoints/internal_v4_endpoint",
            };
            let ca = str_at(entry, "/master/master_auth/cluster_ca_certificate")
                .map(|pem| base64::engine::general_purpose::STANDARD.encode(pem.as_bytes()));
            Ok(CloudCluster {
                provider: CloudProvider::Yandex,
                name: str_at(entry, "/name").unwrap_or_else(|| id.clone()),
                account: folder.to_owned(),
                location: str_at(entry, "/master/zonal_master/zone_id")
                    .or_else(|| str_at(entry, "/master/regional_master/region_id"))
                    .unwrap_or_default(),
                resource_group: None,
                context: format!("yc-{id}"),
                cloud_id: Some(id),
                endpoint: str_at(entry, endpoint_path),
                certificate_authority: ca,
                version: str_at(entry, "/master/version"),
                status: str_at(entry, "/status"),
                yandex: Some(selection.clone()),
            })
        })
        .collect()
}

pub(super) fn login_command(profile: &str) -> String {
    if profile.is_empty() {
        "yc init".into()
    } else {
        format!("yc init --profile {}", shell_word(profile))
    }
}

pub(super) fn exec_for(cluster: &CloudCluster) -> CoreResult<(String, Value)> {
    let selection = cluster
        .yandex
        .as_ref()
        .ok_or_else(|| CoreError::new(ErrorCode::Invalid, "the YC profile is missing"))?;
    plain_arg(&selection.profile, "profile")?;
    let id = cluster
        .cloud_id
        .as_deref()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| CoreError::new(ErrorCode::Invalid, "the YC cluster id is missing"))?;
    plain_arg(id, "cluster id")?;
    if selection.profile.is_empty() {
        return Err(CoreError::new(
            ErrorCode::Invalid,
            "the YC profile is empty",
        ));
    }
    Ok((
        format!("yc-{id}"),
        json!({
            "apiVersion":EXEC_API_VERSION,"command":"yc",
            "args":["managed-kubernetes","create-token","--profile",selection.profile,"--no-browser"],
            "env":[{"name":"YC_IAM_TOKEN","value":""}],
            "interactiveMode":"Never",
            "installHint":format!("Install the Yandex Cloud CLI: {}",CloudProvider::Yandex.install_url())
        }),
    ))
}

impl CloudCli {
    async fn yc_call(
        &self,
        profile: &str,
        scope: Option<&str>,
        command: &[&str],
        flags: &[(&str, &str)],
    ) -> Result<String, CloudProblem> {
        let mut argv = args(command);
        argv.extend(flags.iter().map(|(k, v)| format!("--{k}={v}")));
        argv.extend([
            format!("--profile={profile}"),
            "--format=json".into(),
            "--no-browser".into(),
            "--no-user-output".into(),
        ]);
        self.call_ok(CloudProvider::Yandex, scope, profile, &argv)
            .await
    }

    async fn yc_property(&self, profile: &str, property: &str) -> Option<String> {
        let argv = args(&[
            "config",
            "get",
            property,
            &format!("--profile={profile}"),
            "--no-browser",
        ]);
        let output = self.call(CloudProvider::Yandex, None, &argv).await.ok()?;
        if !output.success {
            return None;
        }
        let value = output.stdout.trim();
        (!value.is_empty() && plain_arg(value, property).is_ok()).then(|| value.to_owned())
    }

    /// Profiles, clouds and folders for the selected scope, without changing yc's active profile.
    pub async fn yandex_accounts(
        &self,
        profile: Option<&str>,
        cloud_id: Option<&str>,
    ) -> CloudAccounts {
        let mut result = CloudAccounts {
            provider: CloudProvider::Yandex,
            accounts: Vec::new(),
            regions: Vec::new(),
            problem: None,
            yandex: None,
        };
        let mut discovery = YandexDiscovery::default();
        let profiles = self
            .call_ok(
                CloudProvider::Yandex,
                None,
                "",
                &args(&["config", "profile", "list", "--no-browser"]),
            )
            .await
            .and_then(|text| {
                parse_profiles(&text).map_err(|e| invalid_output(CloudProvider::Yandex, e))
            });
        match profiles {
            Ok(profiles) => discovery.profiles = profiles,
            Err(problem) => {
                result.problem = Some(problem);
                result.yandex = Some(discovery);
                return result;
            }
        }
        let chosen = match profile {
            Some(name) => discovery.profiles.iter().find(|p| p.id == name),
            None => discovery
                .profiles
                .iter()
                .find(|p| p.is_default)
                .or_else(|| discovery.profiles.first()),
        }
        .map(|p| p.id.clone());
        let Some(profile) = chosen else {
            result.problem = Some(if discovery.profiles.is_empty() {
                CloudProblem {
                    command: Some("yc init".into()),
                    ..problem(
                        CloudProvider::Yandex,
                        CloudProblemKind::NotLoggedIn,
                        None,
                        "yc has no configured profiles".into(),
                    )
                }
            } else {
                problem(
                    CloudProvider::Yandex,
                    CloudProblemKind::Failed,
                    None,
                    "the selected yc profile no longer exists; choose a profile again".into(),
                )
            });
            result.yandex = Some(discovery);
            return result;
        };
        discovery.profile = Some(profile.clone());
        if let Some(id) = cloud_id
            && plain_arg(id, "cloud id").is_err()
        {
            result.problem = Some(problem(
                CloudProvider::Yandex,
                CloudProblemKind::Failed,
                None,
                "invalid cloud id".into(),
            ));
            result.yandex = Some(discovery);
            return result;
        }
        let (default_cloud, default_folder) = futures::join!(
            self.yc_property(&profile, "cloud-id"),
            self.yc_property(&profile, "folder-id")
        );
        match self
            .yc_call(&profile, None, &["resource-manager", "cloud", "list"], &[])
            .await
            .and_then(|text| {
                parse_accounts(&text, default_cloud.as_deref())
                    .map_err(|e| invalid_output(CloudProvider::Yandex, e))
            }) {
            Ok(clouds) => discovery.clouds = clouds,
            Err(error) => discovery.problems.push(error),
        }
        if let Some(id) = default_cloud.as_ref()
            && !discovery.clouds.iter().any(|c| c.id == *id)
        {
            discovery.clouds.push(account(id.clone(), None, Some(id)));
        }
        discovery.cloud_id = cloud_id
            .map(str::to_owned)
            .or_else(|| default_cloud.clone())
            .or_else(|| discovery.clouds.first().map(|c| c.id.clone()));
        if let Some(id) = discovery.cloud_id.as_deref() {
            match self
                .yc_call(
                    &profile,
                    Some(id),
                    &["resource-manager", "folder", "list"],
                    &[("cloud-id", id)],
                )
                .await
                .and_then(|text| {
                    parse_accounts(&text, default_folder.as_deref())
                        .map_err(|e| invalid_output(CloudProvider::Yandex, e))
                }) {
                Ok(folders) => result.accounts = folders,
                Err(error) => discovery.problems.push(error),
            }
        }
        if discovery.cloud_id == default_cloud
            && let Some(id) = default_folder
            && !result.accounts.iter().any(|f| f.id == id)
        {
            result.accounts.push(account(id.clone(), None, Some(&id)));
        }
        result.yandex = Some(discovery);
        result
    }

    pub(super) async fn find_yandex(&self, query: &CloudQuery) -> CoreResult<CloudSearch> {
        let selection = query.yandex.as_ref().ok_or_else(|| {
            CoreError::new(
                ErrorCode::Invalid,
                "the YC profile and endpoint are required",
            )
        })?;
        for (value, label) in [
            (&selection.profile, "profile"),
            (&query.account, "folder id"),
        ] {
            plain_arg(value, label)?;
            if value.trim().is_empty() {
                return Err(CoreError::new(
                    ErrorCode::Invalid,
                    format!("{label} is empty"),
                ));
            }
        }
        let found = self
            .yc_call(
                &selection.profile,
                Some(&query.account),
                &["managed-kubernetes", "cluster", "list"],
                &[("folder-id", &query.account)],
            )
            .await
            .and_then(|text| {
                parse_clusters(&text, &query.account, selection)
                    .map_err(|e| invalid_output(CloudProvider::Yandex, e))
            });
        Ok(match found {
            Ok(clusters) => CloudSearch {
                clusters,
                problems: Vec::new(),
            },
            Err(error) => CloudSearch {
                clusters: Vec::new(),
                problems: vec![error],
            },
        })
    }
}
