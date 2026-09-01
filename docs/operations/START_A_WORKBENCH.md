# Start a Workbench

Start with an Environment, not a copied application repository. Create a separate consumer repository only after the Workbench needs product-owned code or lifecycle.

## Choose the shape

| Need | Start with | Separate repository |
| --- | --- | --- |
| A project-free Session UI using Platform capabilities | A Profile and the built-in Minimal Host | No |
| A repeatable Skill or constrained-data evaluation | A Profile plus consumer-owned inputs and evidence | Optional; use one when those inputs need versioning or collaboration |
| Custom routes, UI, adapters, product state, authorization or deployment | A consumer application that pins `@agent-workbench/platform` | Yes |

An Environment is isolated instance data created from a declarative Profile. It is not source code and does not create a repository.

## Create the default shape

1. Write a secret-free Environment Profile. Choose `docker` with a minimum level of `ephemeral-machine` when the Workbench must be strongly isolated; `development` is explicitly non-isolated.
2. Create and run the Environment:

   ```bash
   agent-workbench env create --profile ./profile.json --root ./data/environments
   agent-workbench env run <environment> --root ./data/environments
   ```

3. Inspect the effective contract instead of inferring isolation from a successful start:

   ```bash
   agent-workbench env inspect <environment-or-run> --root ./data/environments
   ```

4. Stop the Run when finished:

   ```bash
   agent-workbench env stop <environment-or-run> --root ./data/environments
   ```

Running an Environment creates a new immutable Run. Running a retained, stopped Run resumes its Session state. Profile examples, bindings, provider guarantees and lifecycle details are defined in [`ENVIRONMENTS.md`](ENVIRONMENTS.md).

## Keep only the owning assets

Keep as source when the Workbench must be reproducible:

- the secret-free Profile and Capability lock declarations;
- consumer-owned Skill sources or extensions;
- any product or evaluation policy, cases, Gold and evidence that the consumer actually needs.

Keep credential bindings and credential values in private controller state. Environment and Run directories are generated state, not a source repository. The Minimal Host does not require or create `policies/`, `evaluations/` or `gold/`.

## Upgrade to a consumer repository

Create a consumer repository when the Workbench first needs custom routes, UI, adapters, persistence, authorization, product vocabulary, retention or deployment. Pin a released Platform version and import shared contracts; do not copy Platform or Personal Workbench implementations.

A consumer commonly owns `package.json`, one or more Profiles, its product source, documentation and tests. That layout is illustrative, not a Platform contract. The stable ownership boundary is defined in [`../architecture.md`](../architecture.md).

The current CLI creates Environments; it does not scaffold consumer applications. A future initializer should preserve the same two-stage decision: generate a Profile and Environment by default, and create a consumer repository only when product-owned code is explicitly requested.
