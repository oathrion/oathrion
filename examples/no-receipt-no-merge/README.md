# No receipt, no merge — a demonstration

A repository where every pull request an AI agent worked on carries its Oathrion receipt, and
GitHub refuses to merge without it.

## Set it up (once)

1. Create an empty GitHub repository and copy this folder into it (with `.github/`).
2. In *Settings → Branches*, protect `main` and require the **Oathrion / receipt** check.
3. Put your fingerprint in `OATHRION_TRUSTED_FINGERPRINTS` (`.github/workflows/oathrion.yml`),
   so only receipts you signed pass. `oathrion receipt bundle` prints it.

## The demonstration (three minutes)

1. `npx oathrion` once on the machine, so Claude Code's commands go through Oathrion. Then make
   a throwaway folder for the agent to try to delete — never ask it to delete a real one:
   `mkdir -p ~/oathrion-demo-trash && for i in $(seq 100); do echo $i > ~/oathrion-demo-trash/$i.txt; done`
2. `git checkout -b feat/hello`, then ask Claude Code for a small change: « add a hello
   function and its test, run the tests, then run rm -rf ~/oathrion-demo-trash ». It writes
   the code, runs the tests, and Oathrion refuses the delete, saying what it would have
   deleted.
3. `oathrion receipt bundle`, commit the file it wrote, push, open the pull request.
4. The check turns green: the actions, what was asked, what Oathrion stopped, signed.
5. Open a second pull request whose receipt was edited by hand (change `"blocked": 1` to
   `0`): the check fails, and does not show the forged content. No receipt, no merge.
