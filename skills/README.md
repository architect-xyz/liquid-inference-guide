# Skills

Agent skills for Liquid Inference. Each directory holds one `SKILL.md` with `name` and `description` frontmatter. An agent loads a skill when the task matches its description.

| Skill | Use it to |
| --- | --- |
| [liquid-quickstart](liquid-quickstart/SKILL.md) | Point a client at the exchange and send a first request. |
| [liquid-purchasing-rules](liquid-purchasing-rules/SKILL.md) | Set caps, baskets, strategy, limits, headers and presets. |
| [liquid-models-market](liquid-models-market/SKILL.md) | Read models, offers, prices and depth. |
| [liquid-receipts-costs](liquid-receipts-costs/SKILL.md) | Read receipts, explain charges, attribute spend. |
| [liquid-troubleshoot](liquid-troubleshoot/SKILL.md) | Diagnose error codes and harness symptoms. |
| [liquid-connect-harness](liquid-connect-harness/SKILL.md) | Configure a coding harness. |
| [liquid-agent-sdk](liquid-agent-sdk/SKILL.md) | Run the Claude, OpenAI or Vercel agent SDKs on the exchange. |
| [liquid-modalities](liquid-modalities/SKILL.md) | Overview of attachments, embeddings, images, speech, video. |
| [liquid-images](liquid-images/SKILL.md) | Discover image models and generate images (scripts). |
| [liquid-speech](liquid-speech/SKILL.md) | Discover speech models and synthesize audio (scripts). |
| [liquid-video](liquid-video/SKILL.md) | Create, poll and download video (scripts). |
| [liquid-embeddings](liquid-embeddings/SKILL.md) | Discover embedding models and embed text (scripts). |
| [liquid-become-provider](liquid-become-provider/SKILL.md) | Sell inference with a provider agent. |

## Install

Copy the directories you want into your agent's skills folder, for example for Claude Code:

```bash
mkdir -p ~/.claude/skills
cp -R skills/liquid-* ~/.claude/skills/
```

OpenRouter's skills install with `gh skill install`. We have not checked that this repository's layout works with that command or with `npx skills`.

## Status

Written from the Liquid Inference product docs. Not tested by loading them into an agent. The modality scripts' discovery commands ran against the live exchange; the commands that spend money were not run. Skills that link to guides use paths in this repository, so they work best when the agent can reach it.
