# Releasing OpenEnlarge

Releases are built by `.github/workflows/release.yml` when a `v*` tag is pushed.

## One-time GitHub secrets (Settings → Secrets and variables → Actions)

**macOS (sign + notarize):**
- `APPLE_CERTIFICATE` — base64 of your Developer ID Application `.p12`: `base64 -i cert.p12 | pbcopy`
- `APPLE_CERTIFICATE_PASSWORD` — the `.p12` export password
- `APPLE_SIGNING_IDENTITY` — e.g. `Developer ID Application: Your Name (TEAMID)`
- `APPLE_ID` — your Apple ID email
- `APPLE_PASSWORD` — an app-specific password (appleid.apple.com → Sign-In and Security)
- `APPLE_TEAM_ID` — your 10-char Apple Team ID

**Windows (sign):**
- `WINDOWS_CERTIFICATE` — base64 of your code-signing `.pfx`
- `WINDOWS_CERTIFICATE_PASSWORD` — the `.pfx` password

If a platform's secrets are absent, that platform still builds — unsigned.

## Cutting a release

```bash
# bump version in app/src-tauri/tauri.conf.json + app/package.json first if needed
git tag v0.1.0
git push origin v0.1.0
```

The workflow creates a **draft** release with all installers attached. Review it, then publish.
