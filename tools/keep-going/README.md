# Local pi-keep-going Codex fix

`/kg auto` originally accepts only `openai-codex`, not the `openai` provider used by this session. This patch permits a manual `/kg auto` on `openai` to query **separately logged-in Codex OAuth quota**. It never uses the selected OpenAI API key for the ChatGPT endpoint or changes model selection. The notification explicitly identifies the separate quota. Without that OAuth login, it recommends `/login openai-codex` or a manual duration.

This does not imply OpenAI API quota and Codex subscription quota are interchangeable. Automatic settled-error handling stays tied to the actual provider; only the explicitly requested command gets the fallback.

Codex reset parsing now respects exhausted secondary (weekly) windows, waits for all exhausted windows to recover, and rejects invalid/past reset timestamps.

## Apply after reinstall/update

```sh
patch -p1 -d "$HOME/.pi/agent/npm/node_modules/pi-keep-going" < tools/keep-going/codex-auto.patch
node tools/keep-going/check.cjs
```

The patch targets the locally installed source layout. If it no longer applies cleanly, inspect the updated package rather than force it. The checks accept optional plugin directory and Pi installation directory arguments; the default Pi installation is `~/.pi/agent/install/releases/1.3.0`.

Checks use synthetic credentials and mocked HTTP, exercise the actual command handler, and leave credentials/settings untouched. No live quota API call is made. They cover missing OAuth login, safe credential-provider selection, explicit fallback messaging, native Codex, unsupported providers, account headers, and primary/secondary reset selection.

Restart Pi or use `/reload` to load changed extension code. Existing in-memory jobs are not evidence the new code has loaded. A package update may overwrite the local patch. No changes are needed under `~/.pi/agent/keep-going` (runtime leases only).
