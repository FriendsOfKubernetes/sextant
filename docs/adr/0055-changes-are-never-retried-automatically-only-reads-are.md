# ADR-0055: A request that changes the cluster is never retried automatically; only reads are

## Context

The client retried 429/503/504 up to 3 times (at most 5 s) for requests with a cloneable body. After a 504 on a POST, PUT or DELETE the server may already have applied the change, so the retry came back as "already exists" or "conflict" and the user saw a false error for a change that had worked (issue #66).

## Decision

The retry policy retries only GET and HEAD (reads, lists, watches). POST, PUT, DELETE and PATCH are sent once. A 504 on a change is reported as a timeout with the message "The server timed out; the change may have been applied - check the object".

## Why

- Keeping the retry for all methods was rejected: it is the cause of the bug.
- Retrying PATCH where "it is safe" was considered and dropped in the spec: whether a patch is idempotent depends on its content (a merge patch to a value is, a JSON patch `add` to an array or an increment is not), and the client cannot tell. "Only GET-like" is the rule that does not need that judgement.
- Retrying on an "already exists/conflict" with a follow-up read to detect our own change was rejected as more machinery than the case deserves; the user is told to check the object.

## Consequences

- A transient 429/503 on a change now reaches the user at once, where it used to be absorbed; they retry by hand.
- A 504 on a change leaves the outcome unknown; the message says so instead of guessing.
- The rule applies to everything built on the client, the agent's tools and extension calls included.
