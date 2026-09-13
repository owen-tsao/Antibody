# Antibody — self-healing for AI agents

Antibody attacks your AI agent on purpose, proves each failure, patches it, and guarantees the patch never breaks anything that used to work. Every failure becomes a permanent regression test; every patch must pass all of them; helpfulness never drops.

How it works: a Chaos Agent invents attacks (prompt injection hidden in data, social-engineered refunds, tools that return nothing), a Judge proves the failure with verifiable checks, a Repair Agent patches the target agent's prompt and its tool-permission code, and an eval gate in Weave accepts the patch only if it fixes the break, passes every past failure, and keeps normal users working. Then the Chaos Agent studies the new defenses and attacks again.

The demo target is a customer-support agent for an online store with real (mocked) tools. The loop itself is the product.

Built at CoreWeave Hacks (Agent Loops), September 12–13, 2026. All code written on-site. See `PLAN.md` for the build plan and `REVIEW.md` for its review.
