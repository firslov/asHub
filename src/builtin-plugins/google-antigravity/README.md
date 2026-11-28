# Google Antigravity project review (experimental)

This desktop integration is separate from the Gemini API-key provider and from interactive Antigravity chat. The plugin handles process startup, login messages, proxy selection, and the read-only review protocol. The Hub owns project membership, dispatch, identity, and durable delivery.

## Try it locally

1. Install the Antigravity CLI (`agy`). If needed, run `agy acp --login` in Terminal to sign in.
2. Quit the running asHub desktop instance and launch the development build with `ASHUB_EXPERIMENTAL_ANTIGRAVITY_WORKER=1 npm run electron:dev`. The backend is not advertised without the flag. Interactive chats are unchanged.
3. In an isolated test project, choose **New conversation → Model → Google Antigravity (Experimental)**. Click **Authorize Antigravity for this project** and confirm the one-time project authorization. The same control is available in **Manage project**. Existing projects are off by default.
4. From an eligible conversation in the same project, dispatch a review using only synthetic, non-sensitive task text or inline excerpts. There is no per-task popup. Direct prompts to the project worker are not supported. Revocation blocks unsent tasks immediately; it cannot retract text already sent, and re-enabling does not revive unsent tasks from the previous authorization.
5. Read and verify the structured delivery in your normal project workflow. A blocked review lists what is missing; it does not notify the coordinator separately or start a follow-up. Malformed output, disconnects, and responses without a normal end cannot count as a delivery. A completed task is not proof that the model's conclusions are correct.

## Boundaries

- The backend declares `inline-review` and requires project authorization. The Hub owns the grant and preserves existing project approvals without migrating them. Creating through the project management plugin and dispatching both check the grant; the bridge rechecks with the Hub just before sending the prompt.
- Each approved task starts a fresh ACP session. No previous remote session is restored, no task MCP server is registered, and the prompt carries only the approved dispatch text plus fixed review instructions and a per-turn token. Project paths, history, task IDs, and attachments are not automatically included.
- The CLI runs from a private empty temporary directory using its sandbox flag with default customizations turned off. The bridge rejects all ACP permission requests and does not pass the asHub token or other model API keys to the process. These controls are not proof of full OS-level confinement of a third-party CLI. Use non-sensitive material until real CLI isolation is verified.
- Designed for reviewing inline materials, not browsing, reading the repository, running checks, or editing. The plugin advertises `inline-review` for project members so workflow tooling can enforce an explicit text handoff. Provide approved excerpts as text instead of file paths. Output artifacts are not supported, and live task supplements are unavailable for this backend.
- The regression fixture uses a fake CLI over real ACP stdio and a local Hub; the approval UI is tested in Electron. This does not validate Google account access or the live model's review output.

## Regression checks

```sh
npm run build
node --test tests/antigravity-project-worker.mjs tests/antigravity-acp.mjs tests/antigravity-environment.mjs
npm run test:google:ui
```
