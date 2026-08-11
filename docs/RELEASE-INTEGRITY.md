# Release integrity

The release workflow produces one reviewable integrity bundle for each
semantic-version tag. The bundle contains:

- the exact npm tarball;
- a CycloneDX SBOM generated from `package-lock.json`;
- `SHA256SUMS` covering the tarball, SBOM, and release manifest; and
- `release-manifest.json`, which binds the package identity and SBOM metadata to
  those checksums.

The workflow also creates GitHub attestations for the checksummed subjects and
the SBOM. A published GitHub release receives the same four files as release
assets. No package is published by a tag or release event. Publishing is a
separate, deliberate `workflow_dispatch` input that uses npm trusted publishing
and the exact verified tarball.

## Local preparation and verification

Use Node.js 20 or newer from a clean checkout of the semantic-version tag:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run check
npm audit --omit=dev --audit-level=high
mkdir -p dist/release
npm pack --ignore-scripts --pack-destination dist/release > dist/pack.json
npm sbom --package-lock-only --omit=dev --sbom-format cyclonedx --sbom-type library > dist/release/sbom.cdx.json
npm run release:integrity -- create dist/release
npm run release:integrity -- verify dist/release
```

`verify` fails closed when a release directory contains an unexpected file,
when a checksum is missing or changed, when the manifest does not match
`package.json`, or when the SBOM does not identify the package with its npm
package URL. `SHA256SUMS` uses the standard two-space `sha256sum` format, so it
can also be checked with a platform-provided checksum utility.

## Trusted publishing and attestations

`package.json` opts into public npm access and npm provenance. The optional
manual publish job requires npm trusted publishing to be configured for this
repository's `.github/workflows/release-integrity.yml` workflow and does not
use a long-lived npm token. The job checks out the reviewed tag, downloads the
already-attested bundle, verifies it again, and publishes that tarball with
`npm publish --provenance --access public`.

The release workflow uses least-privilege job permissions. Build attestation
needs `id-token: write` and `attestations: write`; only the release-asset job
gets `contents: write`; the optional npm job gets `id-token: write` only while
publishing. Attestation success is evidence about build origin and artifact
identity, not a security or malware guarantee.
