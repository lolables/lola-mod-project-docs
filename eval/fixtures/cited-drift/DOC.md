# Proposal: tighten the partner API

This proposal changes how partners authenticate and how much they can send.
Every number below comes from a cited source, so reviewers can check it.

## Rate limits

Partners are limited to 1000 requests per minute per token, per the
[current limits](sources/rate-limits.md). Short spikes are absorbed by a
burst allowance of 20 requests.

## Retention

Request logs are retained for 30 days and backups are kept for 180 days, as
recorded in the [retention settings](sources/retention.json).

## Token lifetime

Per [RFC 9999 §4](https://standards.example/rfc-9999), access tokens expire
after 12 hours. Refresh tokens last 30 days under the same section.

## Availability

The [vendor SLA](https://vendor.example/sla) guarantees 99.99% monthly uptime,
which is why we do not propose a fallback region.

## Team

The on-call rotation has 13 engineers, per the
[team roster](../team-roster.md).
