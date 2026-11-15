# Oathrion — no receipt, no merge

When an AI agent worked on a branch, the pull request carries its receipt: what the agent did,
what was asked of a person, what Oathrion blocked, signed and checked offline. This action
verifies it and writes the summary on the pull request's checks.

## On the contributor's side

With Oathrion installed (`npx oathrion`), on the branch the agent worked on:

```bash
oathrion receipt bundle
git add .oathrion/receipts && git commit -m "Oathrion receipt"
```

## On the repository's side

```yaml
# .github/workflows/oathrion.yml
name: Oathrion
on: pull_request
permissions:
  contents: read
jobs:
  receipt:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
          ref: ${{ github.event.pull_request.head.sha }}
      - uses: oathrion/oathrion/action/verify@v0
        with:
          require: "true"
          trusted-fingerprints: "5b24 150f debd 29b2 e0ef 225c e82f e6a5"
```

Make the check required in the branch protection rules: no receipt, no merge.

- `fetch-depth: 0` and the head commit: the action says which commits came after the receipt.
- It needs no secret, so it works on pull requests from forks.
- `trusted-fingerprints`: the fingerprints your contributors published (`oathrion receipt
  bundle` prints theirs). Without it, any valid signature passes, reported as « not pinned ».

## What it proves, and does not

A valid receipt has not changed since it was signed by the key with that fingerprint, and lists
what Oathrion recorded while the agent worked in the repository. It does not prove that nothing
happened outside Oathrion. A fingerprint that is not pinned says someone signed, not who.
