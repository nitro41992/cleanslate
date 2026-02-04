# Plan: Update CLAUDE.md with Recipe System Documentation

## Summary

Update CLAUDE.md with minimal additions to document the Recipe System and new scrub commands introduced in the `fix/recipe-export-command-type` branch.

---

## Edits to Make

### Edit 1: Core Modules Table (~Line 44)

Add new row after Audit Log:

```markdown
| Recipe | `/` (panel) | `recipeStore` | Build, save, and replay transformation sequences |
```

### Edit 2: Directory Structure (~Line 57)

Add under `lib/`:

```markdown
│   ├── recipe/       # Recipe builder and executor
```

### Edit 3: Three-Tier Undo Strategy Table (~Line 88-91)

Update Tier 1 examples to include new scrub commands:

```markdown
| 1 | Expression chaining | Instant | trim, lowercase, uppercase, replace, hash, mask, last4, zero, scramble |
```

Update Tier 3 examples to include scrub:batch:

```markdown
| 3 | Snapshot restore | Slower | remove_duplicates, cast_type, split_column, match:merge, scrub:batch |
```

### Edit 4: Gotchas Section (~Line 343)

Add two new items:

```markdown
- **Recipe Secrets:** Hash secrets are prompted at apply time, never stored in recipes
- **Command Idempotency:** Operations affecting 0 rows skip audit/timeline recording
```

---

## Files to Modify

- `/Users/narasimhakuchimanchi/Documents/Repos/clean-slate/CLAUDE.md`

## Verification

1. Review CLAUDE.md for formatting consistency
2. Run `npm run lint` to check for issues
