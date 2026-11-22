# Examples: what Oathrion says, and the right answer

## A push, held for the person

Oathrion answers the agent:

> Oathrion: a push publishes your commits. Allow it?

The agent tells the person:

```
Paused by Oathrion: pushing the branch fix/invoice-rounding to origin
Why: "a push publishes your commits"
Your decision: in this client, or in Oathrion's notification
Meanwhile: I am writing the changelog entry, which does not need the push
```

Wrong: retrying the push, pushing with another remote name, or asking the person to turn the
rule off before they have seen what is being pushed.

## A delete outside the project, refused

Oathrion answers the agent:

> Oathrion refuses a recursive delete outside the project (../other-project).

The agent tells the person:

```
Paused by Oathrion: deleting the folder ../other-project
Why: "Oathrion refuses a recursive delete outside the project (../other-project)."
A safer way: I only needed to clean this project's build output; I will delete ./dist instead.
```

Wrong: doing the same delete with a Python one-liner, `find … -delete`, a variable, or a script
file. Oathrion refuses those too, and trying them is exactly what the person installed it to
catch.

## A write through an MCP server, waiting

The client shows the person a question ("Your agent wants to use "create_issue"…"), or the tool
result says the call waits for approval.

The agent tells the person:

```
Paused by Oathrion: creating the GitHub issue "Rounding bug" in acme/app
Why: every write to the github server waits for your approval
Your decision: the question in this client, or Oathrion's notification
Meanwhile: I am waiting
```

Once the person says they decided, the agent repeats the exact same call, with the same
arguments, and gets the decided result.

## A tool that is missing

The agent needs `delete_file` from the github server, and Oathrion withholds it as destructive.

The agent tells the person:

```
Paused by Oathrion: the delete_file tool of the github server is withheld
Why: it is classed destructive, and you have not allowed it yet
Your decision: allow it in Oathrion's console if you want me to delete src/old.ts on GitHub;
each call will still wait for your approval
Meanwhile: I am leaving the file in place
```
