# Lessons

## Tooling

- On Windows PowerShell, prefer `npm.cmd` instead of `npm` because execution policies can block `npm.ps1`.

## TypeScript

- When `exactOptionalPropertyTypes` is enabled, props that may explicitly receive `undefined` need `| undefined` in their types or conditional prop spreading.

## Product Modeling

- For business models, raw financial fields are not enough; inputs should map to user mental models such as team members, scenario bands, and decision-oriented comparisons.
- For operating models, "configurable" is not the same as "many fields": the model must match the revenue and cost engine of the business, then expose monthly tables and switchable charts around that engine.
- When a user explicitly asks for a compact, product-grade workflow, large navigation cards are often the wrong answer; primary flows should collapse into tabs or segmented navigation before adding more sections.
- Split product shells early: `App.tsx` should orchestrate workspace state and page routing, while dashboards, navigation, and input workbenches live in dedicated components.
