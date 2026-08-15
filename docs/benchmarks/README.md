# Local benchmark

`benchmarks/run.js` measures a small, disposable WorktreeProof flow with Node's
standard library only. Each iteration creates a fresh temporary repository
directory and invokes the checked-in CLI in this order:

`doctor` → `plan` → `reserve` → `run node --version` → `status` → `close` →
`release` → `validate` → `cleanup --dry-run`.

The harness asserts that every command returns a successful JSON envelope and
that the final receipt validates. It reports elapsed milliseconds for each
operation and min/median/max summaries. Paths, UUIDs, timestamps, and receipt
contents are intentionally not included in the result so two runs can be
compared without leaking local details.

## Run it

From the repository root:

```sh
npm run benchmark
node benchmarks/run.js --iterations 10 > benchmark.json
```

PowerShell:

```powershell
node .\benchmarks\run.js --iterations 10 | Tee-Object benchmark.json
```

The default is three iterations. Use a positive integer from 1 through 25;
larger runs are intentionally rejected to keep this a bounded diagnostic. The
script exits non-zero if an invocation fails. It does not install packages,
contact a service, mutate the checkout, or delete anything outside the temporary
directories it creates. Temporary directories are removed in a `finally` block.

## Interpreting results

Record the Node.js version, operating system, architecture, iteration count,
and the unmodified JSON output when sharing a result. Timings depend on CPU,
filesystem, antivirus, Node.js, and process-start conditions. This is a local
regression and reproducibility harness, not a standardized performance test or
comparison with another product. It says nothing about security, correctness,
adoption, hosted-service behavior, or the safety of the command you choose to
run. The measured child command is the harmless `node --version`; changing it
changes the workload and the risk.
