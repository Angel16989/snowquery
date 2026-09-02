# Void Platform Development Workflow

This project is operated with an enterprise-style GitHub workflow. Production is protected and changes must be traceable, reviewable, and reversible.

## Environment policy

- Local development is the default place to build and test changes.
- The development website is used for integration testing and feature review.
- Staging is used for production-like verification before release.
- Production is served only from the production domain and the production deployment path.
- A change must never be made directly on production unless Rasik explicitly authorizes that exact change.
- Production data is never used for disposable tests. Use clearly prefixed test records such as `zz_` and remove them after verification.

## GitHub branch policy

- `main` represents production and must remain deployable.
- `develop` represents ongoing integration work.
- `staging` represents the release candidate, when staging is enabled.
- Feature, fix, chore, and documentation work starts from the appropriate non-production branch in a short-lived branch, for example:
  - `feature/morning-brief-sports`
  - `fix/cloudflare-redirect`
  - `chore/update-dependencies`
  - `docs/development-workflow`
- Never develop directly on `main`, `develop`, or `staging`.
- Never force-push shared branches.
- Keep secrets, tokens, passwords, database dumps, local configuration, and generated artifacts out of Git.

## Pull request and merge policy

Every change follows this sequence:

1. Create a branch from the correct base branch.
2. Make the change locally and run the relevant tests.
3. Commit with a clear, focused message.
4. Push the branch to GitHub.
5. Open a pull request with a summary, test evidence, affected environment, database impact, and rollback plan.
6. Review the diff and checks before merging.
7. Merge the PR using the repository's protected-branch rules.
8. Deploy only the branch that corresponds to the target environment.
9. Verify the deployment, logs, health checks, and important user flows.

Production releases must be PR merges into `main`. A direct push to `main` is not permitted unless Rasik explicitly requests it for a specific emergency or maintenance action.

## Deployment rules

- A local change is not considered live until the intended GitHub branch has been merged and the matching deployment has been verified.
- Development deploys from `develop`; staging deploys from `staging`; production deploys from `main`.
- Cloudflare DNS, Tunnel, and Access settings are infrastructure changes: document them, review them, and verify the affected hostname after deployment.
- Do not migrate or replace an existing Cloudflare Tunnel configuration without explicit approval because tunnel migration can be irreversible.
- Before restarting a service, confirm the target host, port, process, and environment. This application does not rely on hot reload; stop the existing process/container cleanly before starting the replacement.

## Database safety

- Treat production databases as authoritative and sensitive.
- Take a verified backup before migrations or destructive operations.
- Prefer additive, backward-compatible migrations.
- Test migrations against a disposable database or restored backup first.
- Never overwrite production data or replace a production database as part of routine deployment.
- Any destructive SQL requires explicit approval, a documented reason, and a rollback or restore path.

## Required verification

At minimum, verify the checks relevant to the change:

- linting, formatting, type checks, or compilation;
- unit/integration tests;
- API health and representative API requests;
- frontend build and the affected user flow;
- container/service status and logs;
- the correct hostname and Cloudflare Access behavior;
- GitHub branch and working-tree status after deployment.

Record failures and known limitations in the PR rather than silently working around them.

## Emergency changes

If Rasik explicitly authorizes a direct production change, first record the exact scope and reason, make the smallest reversible change, verify production immediately, and follow up with a normal branch/PR so the repository and deployment history remain accurate.

## Source of truth

GitHub is the source of truth for application code and deployment history. The production database is the source of truth for live data. Local machines and tower workspaces are working copies and must be synchronized through Git rather than treated as undocumented sources of truth.
