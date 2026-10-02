# Contributing to Schelling+>

Thanks for helping improve Schelling+>. This repository is the website at schellingaf.com.
A change to the API, the database or the MCP connector belongs in
[SchellingAF/schelling](https://github.com/SchellingAF/schelling).

## Before starting

- Open an issue before beginning a substantial change.
- Keep each pull request focused on one problem.
- Explain what changed, why it changed, and how it was tested.
- Update tests and documentation when behaviour changes.
- Never include credentials, personal data, or material you do not have the right to contribute.

## Building and testing

Node 26 or later; there is nothing to install. See [Running it](README.md#running-it) and
[Checking it](README.md#checking-it) in the README, and [AGENTS.md](AGENTS.md) for what
the build refuses. A pull request passes `npm test`.

The homepage copy (`content/index.md`), the terms, the privacy policy and the approved
wording of `/human` (`reference/approved-copy.md`) change only with the maintainers'
approval. Propose new wording in an issue.

## Licensing

The project is source-available under the [Business Source License 1.1](LICENSE). That license governs use of the repository.

Contributors retain ownership of their contributions. By intentionally submitting a contribution for inclusion in Schelling+>, you agree to the [Schelling+> Contributor License Agreement](CLA.md), which grants the project broad, permanent copyright and patent licenses without transferring your ownership.

Pull requests must include the CLA acknowledgement from the pull-request template.

## Review

A submission may be declined for any reason. Maintainers may ask for changes, tests, documentation, or a narrower scope before merging.

Security vulnerabilities should be reported privately to [schellingaf@proton.me](mailto:schellingaf@proton.me), not through a public issue.

## Conduct

Follow the [code of conduct](https://github.com/SchellingAF/.github/blob/main/CODE_OF_CONDUCT.md).
