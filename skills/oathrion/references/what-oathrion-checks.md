# What Oathrion checks

What happens to each kind of action once the person has run `npx oathrion`. Use it to explain a
decision to the person, never to find a way around one.

## Through MCP servers (`oathrion wrap`)

| Kind of tool | What happens |
|---|---|
| Reads (`get_…`, `list_…`, `search_…`, or declared read-only by the server) | Go through |
| Writes (create, update, send, merge, push…) | Wait for the person's approval, once, for the session, or always |
| Destructive (delete, pay, run a command, overwrite) | Blocked until the person allows them; then each call waits for approval |
| A tool whose description or schema changed | Withheld until the person accepts it again |

When an MCP client can ask questions itself, the approval appears in the client; otherwise in
Oathrion's notification, the console, or the phone.

## Claude Code's own shell and file edits (the hook)

**Refused** (the agent is told why):

- a recursive delete outside the project, at the root or of the home folder, however it is
  written (shell, `find`, a one-line Python, Node, Ruby or Perl script, a pipe, a variable set
  on the same line);
- `rsync --delete` into the root or outside the project;
- a forced `git push`;
- running a script straight from the network (a download piped into a shell);
- making a whole tree writable by everyone;
- writing outside the project, or into Oathrion's own files, the client's settings or its hooks;
- anything that carries one of the decoys planted by `oathrion decoys plant`.

**Asked** (the person decides):

- a `git push`, or publishing a package;
- deleting the project's git history, `git reset --hard`, `git clean -f`, or force-deleting the
  main branch;
- deleting data from a database through its command-line client (DROP, TRUNCATE, a DELETE
  without WHERE);
- `docker … prune`, `docker volume rm`, `docker compose down -v`;
- a recursive delete or an `rsync --delete` whose path is a variable Oathrion cannot read;
- `gh pr merge`, publishing or deleting a GitHub release, deleting or archiving a repository;
- destroying production: a hosting or cloud CLI that deletes (`railway volume delete`,
  `fly apps destroy`, `heroku pg:reset`, `aws … delete-*`, `gcloud … delete`…), `terraform destroy`,
  `terraform apply -auto-approve`, `kubectl delete`, `helm uninstall`, a database reset
  (`prisma migrate reset`, `rails db:drop`, `redis-cli FLUSHALL`…), or a `DELETE` or deleting
  GraphQL mutation sent with `curl` to a hosting provider's API;
- sending a secret file (`.env`, an SSH key, cloud credentials) out of the machine;
- replacing a file that git does not track;
- after the session read untrusted content (a web page, an issue, a message): anything that
  sends data out, or runs a program Oathrion cannot read.

Everything else goes through, and goes to a chained journal.

## Turning a rule off

Only the person does this, in their own file `~/.oathrion/claude-code-rules.json`:

```json
{ "disable": ["git-push"] }
```

The rule names: `rm-outside-project`, `rm-git-history`, `rm-unreadable-path`, `script-delete`,
`rsync-delete`, `docker-prune`, `git-discard`, `git-force-push`, `git-push`, `gh-publish`,
`package-publish`, `sql-destroy`, `db-reset`, `cloud-destroy`, `infra-destroy`, `api-destroy`,
`secret-egress`, `pipe-to-shell`, `chmod-777-recursive`,
`write-outside-project`, `protect-guard-files`, `overwrite-untracked`, `tainted-session`,
`decoy`, `server-token`.

An agent never edits this file: Oathrion refuses it, and doing so would defeat the point.
