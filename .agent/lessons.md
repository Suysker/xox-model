# Lessons

## Tooling

- On Windows PowerShell, prefer `npm.cmd` instead of `npm` because execution policies can block `npm.ps1`.

## TypeScript

- When `exactOptionalPropertyTypes` is enabled, props that may explicitly receive `undefined` need `| undefined` in their types or conditional prop spreading.

## Product Modeling

- For business models, raw financial fields are not enough; inputs should map to user mental models such as members, employees, shareholders, scenarios, and month-level decisions.
- For operating models, “configurable” is not the same as “many fields”. The UI must reflect the real revenue engine and cost engine of the business.
- Split the product shell early. `App.tsx` should orchestrate workspace state and routing, while dashboards and input workbenches live in dedicated components.
- Version management is a workspace action, not automatically a full page. Snapshot, publish, import, and export usually belong in the top-right workspace control.
- If users think in “default month plus exceptions”, store an explicit monthly template. Do not fake that workflow by copying from a real month.
- When screen density matters, put editable defaults in the first row of the working table. Do not spend a separate card or capsule row on “default values” if the user still has to scan the table right below it.
- If users think in “scrubbing through months”, use a true rail or slider instead of a wall of month pills.
- `No horizontal scrollbar` is a product requirement, not a styling preference. Prefer responsive charts, compact controls, and alternative layouts before allowing horizontal scroll.
- For month-by-month operating inputs, fields like event cadence and sales factor should be edited as visual trajectories first and raw numbers second.
- When two monthly drivers are edited together in user thinking, merge them into one linked chart instead of stacking separate charts.
- For dense operational tables, shrinking `min-width` is not enough. Use fixed column widths, center headers, remove redundant per-cell units, and size the inputs to the real editing need.
- In side-by-side dashboard layouts, do not let one pane create fake empty space in the other. If users care about alignment, the cards need a shared visual rhythm.
- Height balance in analytics pages should come from real analytical density, not filler paragraphs.
- When a member analytics page combines a trend chart and a donut chart, keep them inside one shared analysis block and compress the donut legend. A tall one-column legend will create obvious dead space beside the line chart.
- Once per-member cards exceed one screen and repeat the same financial fields, switch to a compact table. Dense operating analysis should default to table rhythm, not stacked cards.
- If one control only affects the selected-month views, place it next to the selected-month table instead of at the top of the whole page. Do not let a month slider visually imply that it drives the long-horizon trend chart.
- In member finance tables, `member` and `employment type` are separate comparison axes. Do not nest type badges inside the member name cell if users need to scan by type.
- If a trend chart is visually the primary month navigator, make the months on the chart clickable and let the selected-month panels follow it. Do not force the user to move their cursor away to a second control for the same selection.
- If a section title already encodes the selected month, remove duplicate month badges from the same panel. Repeating the same value in the top-right wastes space and weakens hierarchy.
- For time-series charts where users compare relative changes between close values, do not anchor the Y axis at zero by default. Use an adaptive range with padding so the variation remains legible.
- In a finance breakdown panel, do not repeat the same cost story in both a detailed list and a second “cost structure” block. Once the breakdown rows already explain the stack, the extra block usually wastes height and creates visual clutter.
- In one dashboard, the primary trend chart should follow the same visual language as the rest of the analysis cards unless there is a strong semantic reason not to. A lone black chart block inside an otherwise light analytics surface usually feels disconnected.
- If the breakdown title already includes the selected month, remove repeated current-month badges from the panel header and month rail. Keep only the progression index if it still adds orientation.
- Remove dead narrative inputs when they stop serving the decision workflow. Deleting `notes` is better than hiding it behind another tab.
- In Chinese finance breakdown rows, avoid uppercase/tracking-heavy label styling and give the breakdown pane enough width before accepting label wraps. These rows are scanning aids; they should read as single-line ledger items whenever possible.
- In split analytics dashboards, reclaim width by reducing inter-panel gutters before shrinking the main chart. Users usually perceive narrow charts sooner than they perceive slightly tighter spacing.
- When a chart metric toggle only changes the chart lens, style it as a lightweight secondary control close to the chart. Do not let `cash / profit / revenue / cost` read like a top-level page navigation bar.

## Financial Domain Modeling

- In entertainment operating models, do not mix performer economics with backstage staffing. A `per-show subsidy` for staff must be modeled as employee cost, not as a performer field.
- When investment comes from multiple people, never collapse startup capital into one scalar if the user is reasoning about ownership. Model shareholders explicitly with both `investmentAmount` and `dividendRate`.
- Separate input modules by business axis, not by implementation convenience. Shareholder capital, revenue engine, and cost structure are different editing jobs.
- Project-level framing assumptions such as `start month` and `horizon` belong with the capital/setup model if the user sees them as the premise of the whole investment, not as part of monthly revenue editing.
- Revenue assumptions and monthly revenue rhythm belong in one `revenue engine` workflow when both are part of the same income judgment in the user’s head.
- Extra online / e-cut income must be a first-class monthly revenue field. Do not hide it in notes or force it into offline sales assumptions.
- In monthly idol-group models, member travel may be configured on a member row, but its financial driver is still `per-show cost`. Bucket costs by economic driver, not by which form owns the field.
- In financial dashboards, never label a subtotal as `totalCost`. If commissions are part of the cost stack, displayed total cost and charts must include commissions too.
