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
- Version management is a workspace action, not always a first-class page. For data tools, actions like snapshot, publish, import, and export usually belong in the top-right control area, with history exposed as a drawer or expandable panel.
- For long business timelines, month-by-month drill-down is too slow. Prefer matrix editing with period controls like start month and horizon length, then auto-fill newly extended months from an existing template.
- If users think in “default month plus exceptions”, the model should store an explicit timeline template. Do not fake that workflow by copying from a real month, or startup months will contaminate the default operating baseline.
- In financial dashboards, never label a subtotal as `totalCost`. If commissions are shown as part of the cost stack, the displayed total cost and cost chart must include commissions too, or users will immediately lose trust in the model.
- For dense operational tables, shrinking `min-width` is not enough. Use fixed column widths, remove redundant per-cell unit suffixes, and size the inputs themselves to the real editing need.
- In side-by-side dashboard layouts, do not let CSS grid stretch analytics cards to match a taller detail pane. Use top alignment, or charts will show fake empty space that reads like a broken product.
- For month-driven finance views, month selectors should behave like a single-line rail with `nowrap` and horizontal overflow. If month chips wrap into two lines, the control stops reading like a timeline.
- If the user thinks in “scrubbing through months”, a true slider/rail is better than a wall of month pills. Keep month labels as lightweight ticks, not a second button toolbar.
- In entertainment operating models, do not mix performer economics with backstage staffing. A `per-show subsidy` for staff must be modeled as employee cost, not as a performer field, or contribution analysis becomes misleading even if total cost stays numerically correct.
- `No horizontal scrollbar` is a product requirement, not a styling preference. For charts, make width responsive and thin labels instead of falling back to `overflow-x-auto`; for month pickers, use a compact grid or calendar-like matrix before allowing horizontal scroll.
- For month-by-month operating inputs, fields like event cadence and sales factor should be edited as visual trajectories first and raw numbers second. If the workflow still feels like filling a spreadsheet, the product model is wrong even when the math is right.
