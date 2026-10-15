// Where the project lives. The repository is the one in the workspace `Cargo.toml`.
export const REPOSITORY_URL = "https://github.com/FriendsOfKubernetes/sextant";

/** The links of the About dialog, in order; `labelKey` is in the `about` namespace. */
export const ABOUT_LINKS = [
  { id: "repository", url: REPOSITORY_URL },
  { id: "wiki", url: `${REPOSITORY_URL}/wiki` },
  { id: "releases", url: `${REPOSITORY_URL}/releases` },
  { id: "discussions", url: `${REPOSITORY_URL}/discussions` },
  { id: "issue", url: `${REPOSITORY_URL}/issues/new/choose` },
] as const;
