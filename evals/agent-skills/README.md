# Agent skill evals

Do the skills in `.claude/skills/` actually help? These tools answer that
question without relying on anyone's history, so a developer on their first
day can use them too.

## 1. Does the skill help at all? (`run.py`)

`run.py` gives Claude the same read-only porting and diagnosis tasks twice:
once with the skills on, and once with them off. It then scores each answer
against a short checklist in `tasks.json` of facts a correct answer must
mention.

```bash
python3 evals/agent-skills/run.py              # 4 tasks x 2 arms x 3 reps, Sonnet
python3 evals/agent-skills/run.py --reps 1     # quick check
```

- **Isolation:** only project settings load, so your personal hooks and plugins don't skew the result.
- **Read the score first, then the cost.** A cheaper answer that misses checks is not a win.
- **Read the saved answers** (the path is printed) before trusting a score. A regex match is not proof the advice is right.
- **When to run it:** each full run costs about 1.5–2M tokens. Run it when a skill changes, not in CI.

## 2. Is it helping me? (`skill-impact.py`)

```bash
python3 evals/agent-skills/skill-impact.py --since <date you started using the skills>
```

This reads your own Claude Code transcripts on your machine. Nothing is
uploaded. It compares your porting sessions with and without the skills, and
lists things worth a second look:

- the same package rebuilt again right after a summary;
- a full log read anyway;
- your pushback in the conversation;
- every `Skill feedback:` line the skills ask the agent to write.

It describes your sessions only. It is not a way to compare developers:
cost depends far more on the task than on the person.

**New to the repo?** You have no "before". To create one, turn the skills off
for some porting tasks, chosen before you start, and compare.

To turn them off, add this to `.claude/settings.local.json`:

```json
{ "skillOverrides": { "porting-software-to-kandelo": "off", "diagnosing-kandelo-build-failures": "off" } }
```

## 3. Where did it help or mislead? (feedback lines)

Each skill asks the agent to end with
`Skill feedback (<skill>): used …; wrong: …; missing: …`.

When a line says something was wrong or missing, fix the skill.
`scripts/test-agent-skills.sh` in CI catches stale paths and names, but only
people reading this feedback catch advice that is well formed and still wrong.
