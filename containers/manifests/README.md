# Build evidence

`scripts/runtime.sh build` writes `images.json` and exact per-image `*.packages.lock` inventories here only after successful builds. No invented image digests or component versions are checked in.

Archive the generated files together with exported images or registry digest references for each release. Chrome's exact requested package version is required at build time; all Debian-resolved component versions (including noVNC and websockify) appear in the inventory.
