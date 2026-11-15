# Security

Oathrion is a governance layer: a flaw in it can become a flaw for everyone who relies on it.
Reports are **welcome**, and publishing a vulnerability remains your right.

## Reporting a vulnerability

Write to **contact@oathrion.com**. Please do not open a public issue.

If you can, tell us:
- the version or commit affected;
- how to reproduce it, and what it allows: bypassing a decision, reading another
  organization's data, reading a secret, executing twice…;
- whether the flaw is already publicly known.

**What we do:**
- an acknowledgement within **3 business days**;
- a first assessment within **10 business days**;
- a fix as fast as the severity requires, then a disclosure that credits you if you wish.

Oathrion is a **preview**, maintained by a small team. These timelines are good-faith
commitments, not a service-level agreement.

## What matters most

In order of severity, for us:
1. an action executed **without** Oathrion's decision, or against it;
2. access to the data or the secrets of **another organization**;
3. a provider secret (GitHub, Stripe, Slack, Linear key) made readable;
4. the same authorization executed **twice**;
5. a tampering of the receipt chain that the full verification would not see.

## What we already know

The known limits are written down, with their reasons, in
[`docs/limitations.md`](docs/limitations.md) and
[`docs/SECURITY-BOUNDARIES.md`](docs/SECURITY-BOUNDARIES.md). A report that extends one of
them is still useful, and we treat it like any other.

## Supported versions

During the preview, only the **latest published version** receives fixes.
