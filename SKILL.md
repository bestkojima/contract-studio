---
name: contract-studio
description: Set up or use Contract Studio for functional-node development, connecting node properties, Sphinx-Needs requirements, CodeLinks function references, frontend operations, and test evidence.
---

# Contract Studio

Develop through functional contracts. The workbench owns graph editing, source persistence, automatic associations and evidence; this skill guides the agent through it. A node can contain several functions. The graph describes behaviour and dependencies; project code executes them.

## Enter the project

Use the existing workbench when present. For an authorized new setup, initialize the bundled neutral template using [workbench setup](references/workbench.md#setup). Copy the template into a new or empty directory; keep the user's existing application and technology choices intact. The template starts with one root group and no business capabilities.

## Work on a node

1. **Read its context.** Use the [workbench entry points](references/workbench.md#node-operations) to discover the feature and fetch the node or its parent. Read the owning source, direct functions, dependencies, gaps and current evidence. A read-only request ends with findings, without saving or executing.
2. **Save the contract.** Capture responsibility, importance, inputs, outputs, rules, errors and observable acceptance in the owning JSON or authored RST. Read [node contracts](references/node-contract.md) when shaping properties or functions. Keep stable IDs and confirmation scope; persist the selected contract and task context before implementation.
3. **Implement through native declarations.** Before adding requirements, specs or markers, read [Needs and CodeLinks](references/needs-codelinks.md). Write native semantic links and exact spec markers; let the index derive node–function–test associations. Keep a deep Module's source selection, sequencing and state behind a small Interface. For requested user-facing capabilities, connect both backend behaviour and frontend input, success, error and process display through [trusted feature registration](references/workbench.md#connect-a-user-capability).
4. **Refresh and demonstrate.** Run `node scripts/build-index.mjs` in the workbench. Read the resulting node context to check properties, direct functions and acceptance-linked tests. Verify affected behaviour through its public Interface within the task's authorization. Report the usable entry, actual evidence and remaining gaps.

## Preserve the framework's meaning

- Edit the owning source once. Generated RST, indexes and node documents are derived; browser drafts become project state only when saved. Layout stays separate from behaviour.
- Semantic associations come from Needs and CodeLinks. The trusted registry contains executable routes, allowed test files and frontend entries, not hand-maintained function or test-case mapping tables.
- Keep unbound nodes pending. Requirement confirmation, source/index freshness and test execution are separate states; a source link or declared test does not establish a passing result. ubCode remains optional and reports its actual connection state.
