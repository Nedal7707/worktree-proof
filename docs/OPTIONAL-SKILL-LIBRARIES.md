# Optional Skill Libraries

WorktreeProof may point to external Agent Skills without bundling them. The record
below describes upstream material, not WorktreeProof authorship or endorsement.

## `amElnagdy/delegate-skills`

- **Upstream URL:** <https://github.com/amElnagdy/delegate-skills>
- **Pinned upstream ref:** `f9f2528525b820e7fd24724f87d6821c0e272947`
- **License:** MIT, as attributed to the upstream project; WorktreeProof does not
  relicense or copy its contents.
- **Purpose:** optional delegation-oriented Agent Skills that an operator may
  inspect and selectively install when a task benefits from them.
- **Provenance:** authored and maintained upstream by `amElnagdy/delegate-skills`;
  this repository stores metadata only.

Example discovery and selective installation commands (run by an operator, not
by WorktreeProof):

```text
npx skills add https://github.com/amElnagdy/delegate-skills --list
npx skills add https://github.com/amElnagdy/delegate-skills --skill <skill-name>
```

WorktreeProof must not vendor, auto-install, authenticate to, or execute this
upstream library. Review its current license, ref, and contents before any
operator-managed installation; the pinned metadata above is not a claim that
the upstream project is safe for every task.

