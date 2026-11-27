# Codex task scope and false-positive reports

An automated cybersecurity check can delay or interrupt legitimate engineering
work. A warning such as `cyber_policy` alone does not establish that a policy
violation occurred.

## Describe the engineering task

State the immediate task, where it runs, and what result would answer it.
Include the context needed to reproduce the behavior. For porting or regression
work, name the component and the upstream behavior under test. Use precise
security terminology when it matters and explain its role in the test.

For example, “Run the upstream Node.js HTTPS certificate-rejection test against
the fixture server in a second Kandelo guest. Record whether the client rejects
the fixture certificate.” This identifies both endpoints and the expected
behavior.

## When a turn is blocked

If a broad request for legitimate work was blocked, retry the specific task
with its actual scope, relevant permissions, and expected result. If the warning
seems mistaken, use the feedback control on the blocked turn (such as thumbs-down)
when the client offers it.

Include these details in a private feedback or support report.

- The exact warning text and error code, if shown.
- The product (Codex, ChatGPT, or API), client, and model used for that turn.
- The date, time, and time zone of the block.
- A request ID or trace ID, if available. If the client exposes only thread and
  turn IDs, give those with their original labels.
- A short, redacted description of the task, the affected guest or host, and
  the relevant workspace or organization name or ID, if applicable.

Use the blocked turn's own record when available. Mark missing details as
unknown. Redact sensitive information from excerpts and screenshots before
sharing. Omit passwords, authorization codes, private keys, and other secrets.
